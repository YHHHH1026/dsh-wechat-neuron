/**
 * 微信 4.1.13+ 数据库密钥「定向提取」（Windows / 只读）。
 *
 * 为什么不再用暴力扫描：
 *   微信 4.1.13 起，密钥不再以裸 32 字节散落内存，而是放在 WCDB 的
 *   `com.Tencent.WCDB.Config.Cipher` 配置对象里，且 blob 被 32 字节掩码 XOR 编码。
 *   逐偏移试 AES 的暴力扫描在本机实测 200s 只覆盖到 level 2/3、0 命中；
 *   而定向提取实测 4.1s 拿到 22/22 个库的密钥并通过 HMAC 全量确认。
 *
 * 关键事实（本机微信 4.1.15.56 实测）：
 *   **每个 .db 有各自独立的密钥**（22 个库 → 22 个不同密钥），
 *   不存在「一个账号一把密钥」。因此返回值是按库映射，不是单个 key。
 *
 * 算法（指针链，两趟扫描）：
 *   1. 趟1：在可读内存里找名字串 "com.Tencent.WCDB.Config.Cipher"，记下地址；
 *   2. 趟2：找 (指针,长度=30) 对 → 回退 0x10 读节点，校验节点内的指针/长度自洽；
 *   3. 节点 +0x28 = config 对象指针；config+0x88 处读 (data_ptr, data_len)；
 *   4. blob 逐字节 XOR 32 字节掩码解码，取 x'<hex>' 字面量 → 32 字节候选密钥；
 *   5. 用页1 HMAC（crypto.js detectAnyProfile）做权威确认，杜绝误报。
 *
 * 内存读取部分为 C#（Add-Type，无需第三方依赖）；判定完全走 JS 侧已验证的 oracle。
 *
 * 算法参考：wechatauto-replica 1.2.8.0（Apache-2.0）wechatauto/db.py
 *   _collect_key_candidates / _keys_from_candidates / _verify_enc_key。
 *   仅借鉴算法思路与结构偏移，未复制其代码；详见 NOTICE。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAGE_SIZE, SALT_SIZE, PROFILES, RAW_PROFILES, detectProfile } from './crypto.js'
import { readHead } from './keyharvest.js'

/** 页1 HMAC 校验用的候选上限（防极端情况下组合爆炸）。 */
const MAX_CANDIDATES = 512

const CSHARP_CIPHER = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public static class WxCipherScan {
  [StructLayout(LayoutKind.Sequential)]
  struct MBI {
    public IntPtr BaseAddress; public IntPtr AllocationBase;
    public uint AllocationProtect; public uint __a1;
    public IntPtr RegionSize; public uint State; public uint Protect; public uint Type; public uint __a2;
  }

  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI mbi, IntPtr len);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);

  static readonly byte[] Name = Encoding.ASCII.GetBytes("com.Tencent.WCDB.Config.Cipher");
  static readonly byte[] Mask = new byte[] {
    0xd2,0xc7,0x44,0x24,0x58,0x02,0x00,0x00,0x00,0x48,0x89,0x44,0x24,0x50,0x48,0x8b,
    0x45,0x00,0x48,0x84,0x4c,0x24,0x48,0x48,0x89,0x44,0x25,0x40,0x48,0x58,0x4c,0x24
  };
  static readonly Regex HexLit = new Regex(@"[xX]'([0-9a-fA-F]{64,192})'", RegexOptions.Compiled);

  static List<KeyValuePair<long,long>> Regions(IntPtr h) {
    var list = new List<KeyValuePair<long,long>>();
    long addr = 0;
    int mbiLen = Marshal.SizeOf(typeof(MBI));
    while (true) {
      MBI mbi;
      if (VirtualQueryEx(h, new IntPtr(addr), out mbi, new IntPtr(mbiLen)) == IntPtr.Zero) break;
      long bas = mbi.BaseAddress.ToInt64();
      long size = mbi.RegionSize.ToInt64();
      // 只读已提交、可读、非 GUARD 的区域；单块上限 256MB 防超大映射拖死。
      if (mbi.State == 0x1000 && ((mbi.Protect & 0xFF) & 0xE6) != 0
          && (mbi.Protect & 0x100) == 0 && size > 0 && size < 0x10000000) {
        list.Add(new KeyValuePair<long,long>(bas, size));
      }
      long next = bas + size;
      if (next <= addr) break;
      addr = next;
    }
    return list;
  }

  static byte[] Read(IntPtr h, long addr, int n) {
    if (addr < 0x10000 || addr >= 0x800000000000L || n <= 0) return null;
    var buf = new byte[n];
    IntPtr got;
    if (!ReadProcessMemory(h, new IntPtr(addr), buf, new IntPtr(n), out got)) return null;
    int take = got.ToInt32();
    if (take <= 0) return null;
    if (take == n) return buf;
    var trimmed = new byte[take];
    Buffer.BlockCopy(buf, 0, trimmed, 0, take);
    return trimmed;
  }

  static int IndexOf(byte[] hay, byte[] needle, int from) {
    // 用 Array.IndexOf 做首字节跳跃（运行时内建、比托管逐字节循环快一个量级），
    // 再验证剩余字节。朴素双层循环在 876MB × 2 趟上实测慢到分钟级。
    int limit = hay.Length - needle.Length;
    if (from > limit) return -1;
    byte first = needle[0];
    int i = from;
    while (i <= limit) {
      int hit = Array.IndexOf(hay, first, i, limit - i + 1);
      if (hit < 0) return -1;
      int j = 1;
      while (j < needle.Length && hay[hit + j] == needle[j]) j++;
      if (j == needle.Length) return hit;
      i = hit + 1;
    }
    return -1;
  }

  static bool Probable(byte[] k) {
    if (k.Length != 32) return false;
    var seen = new HashSet<byte>();
    bool allZero = true, allFF = true;
    for (int i = 0; i < 32; i++) {
      seen.Add(k[i]);
      if (k[i] != 0) allZero = false;
      if (k[i] != 0xff) allFF = false;
    }
    return seen.Count >= 15 && !allZero && !allFF;
  }

  static byte[] FromHex(string s) {
    var b = new byte[s.Length / 2];
    for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
    return b;
  }

  static string ToHex(byte[] b) {
    var sb = new StringBuilder(b.Length * 2);
    for (int i = 0; i < b.Length; i++) sb.Append(b[i].ToString("x2"));
    return sb.ToString();
  }

  public static int Run(string pidCsv, string outPath, int timeoutMs, int maxCandidates) {
    var sw = Stopwatch.StartNew();
    long deadline = timeoutMs > 0 ? timeoutMs : 60000;
    long scanned = 0; int needles = 0, qhits = 0, nodes = 0, blobs = 0, truncated = 0;
    long pass1Ms = 0, pass2Ms = 0, readMs = 0, searchMs = 0, regionCount = 0;
    var phase = Stopwatch.StartNew();
    var ioWatch = new Stopwatch();
    var searchWatch = new Stopwatch();
    var cands = new List<string>();
    var seenCand = new HashSet<string>();
    var needleAddrs = new List<long>();

    foreach (var pidText in pidCsv.Split(',')) {
      int pid;
      if (!int.TryParse(pidText.Trim(), out pid) || pid <= 0) continue;
      IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
      if (h == IntPtr.Zero) continue;
      try {
        var regions = Regions(h);
        regionCount += regions.Count;
        // —— 趟1：找名字串地址 ——
        phase.Restart();
        foreach (var r in regions) {
          if (sw.ElapsedMilliseconds > deadline) { truncated = 1; break; }
          ioWatch.Restart();
          var buf = Read(h, r.Key, (int)r.Value);
          ioWatch.Stop(); readMs += ioWatch.ElapsedMilliseconds;
          if (buf == null) continue;
          scanned += buf.Length;
          searchWatch.Restart();
          int pos = 0;
          while (true) {
            pos = IndexOf(buf, Name, pos);
            if (pos < 0) break;
            needleAddrs.Add(r.Key + pos);
            needles++;
            pos += 1;
          }
          searchWatch.Stop(); searchMs += searchWatch.ElapsedMilliseconds;
        }
        pass1Ms = phase.ElapsedMilliseconds;
        if (needleAddrs.Count == 0) continue;

        // —— 趟2：找 (指针,长度) 对，顺指针链取 XOR blob ——
        var needleSet = new HashSet<long>(needleAddrs);
        var pairs = new List<KeyValuePair<byte[], long>>();
        foreach (var a in needleAddrs) {
          var p = new byte[16];
          Buffer.BlockCopy(BitConverter.GetBytes(a), 0, p, 0, 8);
          Buffer.BlockCopy(BitConverter.GetBytes((long)Name.Length), 0, p, 8, 8);
          pairs.Add(new KeyValuePair<byte[], long>(p, a));
        }
        phase.Restart();
        foreach (var r in regions) {
          if (sw.ElapsedMilliseconds > deadline) { truncated = 1; break; }
          if (cands.Count >= maxCandidates) { truncated = 1; break; }
          ioWatch.Restart();
          var buf = Read(h, r.Key, (int)r.Value);
          ioWatch.Stop(); readMs += ioWatch.ElapsedMilliseconds;
          if (buf == null) continue;
          searchWatch.Restart();
          foreach (var pair in pairs) {
            int pos = 0;
            while (true) {
              pos = IndexOf(buf, pair.Key, pos);
              if (pos < 0) break;
              long qaddr = r.Key + pos;
              pos += 1;
              qhits++;
              var node = Read(h, qaddr - 0x10, 0x50);
              if (node == null || node.Length < 0x40) continue;
              if (!needleSet.Contains(BitConverter.ToInt64(node, 0x10))) continue;
              if (BitConverter.ToInt64(node, 0x18) != Name.Length) continue;
              nodes++;
              long cfg = BitConverter.ToInt64(node, 0x28);
              if (cfg < 0x10000 || cfg >= 0x800000000000L) continue;
              var obj = Read(h, cfg + 0x88, 0x28);
              if (obj == null || obj.Length < 0x18) continue;
              long dp = BitConverter.ToInt64(obj, 0x8);
              long dl = BitConverter.ToInt64(obj, 0x10);
              if (dl <= 0 || dl > 1024) continue;
              var blob = Read(h, dp, (int)dl);
              if (blob == null || blob.Length != dl) continue;
              blobs++;
              var dec = new byte[blob.Length];
              for (int i = 0; i < blob.Length; i++) dec[i] = (byte)(blob[i] ^ Mask[i % Mask.Length]);
              string text = Encoding.ASCII.GetString(dec);
              foreach (Match m in HexLit.Matches(text)) {
                string run = m.Groups[1].Value.ToLowerInvariant();
                var starts = new List<int>();
                starts.Add(0);
                if (run.Length > 96) {
                  for (int s = 0; s + 64 <= run.Length; s += 32) starts.Add(s);
                  starts.Add(run.Length - 64);
                }
                var used = new HashSet<int>();
                foreach (int s in starts) {
                  if (!used.Add(s) || s + 64 > run.Length) continue;
                  var k = FromHex(run.Substring(s, 64));
                  if (!Probable(k)) continue;
                  string kh = ToHex(k);
                  string salt = (s + 96 <= run.Length) ? run.Substring(s + 64, 32) : "";
                  string token = kh + "|" + salt;
                  if (!seenCand.Add(token)) continue;
                  cands.Add("{\"key\":\"" + kh + "\",\"salt\":\"" + salt + "\"}");
                  if (cands.Count >= maxCandidates) break;
                }
                if (cands.Count >= maxCandidates) break;
              }
            }
          }
          searchWatch.Stop(); searchMs += searchWatch.ElapsedMilliseconds;
        }
        pass2Ms = phase.ElapsedMilliseconds;
      } finally { CloseHandle(h); }
      if (cands.Count > 0 || truncated == 1) break;
    }

    var sb = new StringBuilder();
    sb.Append("{\"scanned\":").Append(scanned)
      .Append(",\"needles\":").Append(needles)
      .Append(",\"qhits\":").Append(qhits)
      .Append(",\"nodes\":").Append(nodes)
      .Append(",\"blobs\":").Append(blobs)
      .Append(",\"truncated\":").Append(truncated)
      .Append(",\"regions\":").Append(regionCount)
      .Append(",\"pass1Ms\":").Append(pass1Ms)
      .Append(",\"pass2Ms\":").Append(pass2Ms)
      .Append(",\"readMs\":").Append(readMs)
      .Append(",\"searchMs\":").Append(searchMs)
      .Append(",\"elapsedMs\":").Append(sw.ElapsedMilliseconds)
      .Append(",\"candidates\":[");
    for (int i = 0; i < cands.Count; i++) { if (i > 0) sb.Append(','); sb.Append(cands[i]); }
    sb.Append("]}");
    File.WriteAllText(outPath, sb.ToString());
    return 0;
  }
}
`

function runPowerShell(script, timeoutMs, scriptFile) {
  // 必须带 UTF-8 BOM：Windows PowerShell 5.1 对无 BOM 的 .ps1 按 ANSI 解码，
  // 中文注释乱码后会破坏 C# 源码，报出误导性的「类/结构/接口成员中的标记无效」。
  writeFileSync(scriptFile, `\ufeff${script}`, { encoding: 'utf8' })
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
      { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && error.killed === true) return reject(new Error('timeout'))
        if (error && String(stderr ?? '').trim() !== '') return reject(new Error(String(stderr).trim().split('\n')[0]))
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

/**
 * 用页1 HMAC 确认候选密钥属于哪个库。
 * 显式 salt 形态（key32+salt16）通过替换首页前 16 字节来复用同一个 oracle：
 * salt 只参与 macKey 派生，页体从偏移 16 开始，因此替换后判定完全等价。
 *
 * 性能要点（实测数据，别再踩）：判定成本由 KDF 迭代次数决定，
 * 且 **iterations 与 macIterations 都要看**——sqlcipher4 的 macIterations 只有 2，
 * 但 iterations=256000，单次错配仍要 ~200ms。只看 macIterations 会把昂贵组
 * 误判成廉价组：27 候选 × 22 库 = 594 次错配 × 378ms ≈ 4 分钟。
 * 真正命中的 raw4-sha512（iterations=0, macIterations=2）只要 1ms。
 * 所以分两级：先跑两个迭代数都很小的廉价组，全灭才跑昂贵组且带时间预算；
 * 已确认的库直接跳过。
 */
const CHEAP_MAX_ITERATIONS = 2

function splitProfiles() {
  const cheap = []
  const costly = []
  for (const profile of [...RAW_PROFILES, ...PROFILES]) {
    const kdfCost = Math.max(profile.iterations ?? 0, profile.macIterations ?? 0)
    if (kdfCost <= CHEAP_MAX_ITERATIONS) cheap.push(profile)
    else costly.push(profile)
  }
  return { cheap, costly }
}

function verifyCandidates(candidates, dbHeads, deadlineMs = 20000) {
  const matches = []
  const usedKeys = new Set()
  const { cheap, costly } = splitProfiles()
  const solved = new Set()
  const pending = []

  const tryPair = (cand, key, explicit, target, profiles) => {
    const { path, head } = target
    const hit = detectProfile(head, key, profiles)
    if (hit !== null) {
      matches.push({ db: path, key: cand.key, profile: hit.profile.id, form: 'raw32' })
      usedKeys.add(cand.key)
      solved.add(path)
      return true
    }
    if (explicit !== null) {
      const patched = Buffer.from(head)
      Buffer.from(explicit, 'hex').copy(patched, 0)
      const withSalt = detectProfile(patched, key, profiles)
      if (withSalt !== null) {
        matches.push({ db: path, key: cand.key, salt: explicit, profile: withSalt.profile.id, form: 'key+salt48' })
        usedKeys.add(cand.key)
        solved.add(path)
        return true
      }
    }
    return false
  }

  for (const cand of candidates) {
    let key
    try { key = Buffer.from(cand.key, 'hex') } catch { continue }
    if (key.length !== 32) continue
    const explicit = typeof cand.salt === 'string' && cand.salt.length === 32 ? cand.salt : null
    for (const target of dbHeads) {
      if (solved.has(target.path)) continue
      if (!tryPair(cand, key, explicit, target, cheap)) {
        // 廉价组没命中：留给昂贵组兜底（可能是非主流参数构建）。
        pending.push({ cand, key, explicit, target })
      }
    }
  }

  let costlyTimedOut = false
  for (const item of pending) {
    if (solved.has(item.target.path)) continue
    if (Date.now() > deadlineMs) { costlyTimedOut = true; break }
    tryPair(item.cand, item.key, item.explicit, item.target, costly)
  }

  return { matches, distinctKeys: usedKeys.size, costlyTimedOut }
}

/**
 * 定向提取每个库的密钥。
 * @param {{dbPaths:string[], pids:number[], timeoutMs?:number, debugFile?:string}} options
 * @returns {Promise<{ok:true, keys:Array, steps:string[], elapsedMs:number} | {ok:false, error:string, steps:string[], elapsedMs:number}>}
 */
export async function harvestCipherKeys(options) {
  const started = Date.now()
  const steps = []
  const done = (payload) => ({ ...payload, steps, elapsedMs: Date.now() - started })
  const dbPaths = Array.isArray(options?.dbPaths) ? options.dbPaths.filter((p) => typeof p === 'string' && p !== '') : []
  const pids = Array.isArray(options?.pids) ? options.pids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  const timeoutMs = Number.isInteger(options?.timeoutMs) ? Math.max(5000, options.timeoutMs) : 60000

  if (dbPaths.length === 0) return done({ ok: false, error: 'NO_DB' })
  if (pids.length === 0) return done({ ok: false, error: 'NO_PROCESS' })

  // 收集所有加密库的首页（每库独立密钥，必须逐库校验，不能只取一个代表库）。
  const dbHeads = []
  for (const path of dbPaths) {
    if (!existsSync(path)) continue
    let head
    try { head = readHead(path, PAGE_SIZE) } catch { continue }
    if (head.length < PAGE_SIZE) continue
    if (head.toString('latin1', 0, 15) === 'SQLite format 3') continue
    if (head.subarray(0, SALT_SIZE).every((b) => b === 0)) continue
    dbHeads.push({ path, head })
  }
  if (dbHeads.length === 0) return done({ ok: false, error: 'NO_DB' })
  steps.push(`dbs=${dbHeads.length} pids=${pids.join(',')}`)

  const tempDir = mkdtempSync(join(tmpdir(), 'wxcipher-'))
  const debugFile = typeof options?.debugFile === 'string' ? options.debugFile : null
  const outFile = debugFile !== null ? debugFile : join(tempDir, 'cipher.json')
  const scriptFile = join(tempDir, 'cipher.ps1')
  const script = [
    '$ErrorActionPreference = "Stop"',
    "$src = @'",
    CSHARP_CIPHER,
    "'@",
    'Add-Type -TypeDefinition $src -Language CSharp',
    `$null = [WxCipherScan]::Run('${pids.join(',')}', '${outFile.split('\\').join('/')}', ${timeoutMs}, ${MAX_CANDIDATES})`,
    'exit 0',
  ].join('\n')

  let parsed = null
  try {
    const result = await runPowerShell(script, timeoutMs + 15000, scriptFile)
    if (existsSync(outFile)) {
      try { parsed = JSON.parse(readFileSync(outFile, 'utf8')) } catch { parsed = null }
    }
    const stderr = String(result.stderr ?? '').trim()
    if (stderr !== '') steps.push(`ps=${stderr.split('\n')[0].slice(0, 200)}`)
  } catch (error) {
    // 超时也可能已 flush 出部分结果，先尝试读文件再判失败。
    if (existsSync(outFile)) {
      try { parsed = JSON.parse(readFileSync(outFile, 'utf8')) } catch { parsed = null }
    }
    if (parsed === null) {
      steps.push(`scan=threw ${String(error?.message ?? error)}`)
      return done({ ok: false, error: 'SCAN_FAILED' })
    }
  } finally {
    if (debugFile === null) {
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  if (parsed === null) return done({ ok: false, error: 'SCAN_FAILED' })
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : []
  steps.push(`scanned=${Math.round(Number(parsed.scanned ?? 0) / 1048576)}MB needles=${parsed.needles ?? 0} nodes=${parsed.nodes ?? 0} blobs=${parsed.blobs ?? 0} candidates=${candidates.length}`)

  if (Number(parsed.needles ?? 0) === 0) {
    // 名字串都没找到：微信版本可能换了配置结构名，或主进程没选对。
    return done({ ok: false, error: 'NO_CIPHER_CONFIG' })
  }
  if (candidates.length === 0) return done({ ok: false, error: 'NO_CANDIDATE' })

  // 校验预算：整体 timeout 减去已用时间，至少留 5s；绝不无界跑昂贵参数组。
  const verifyDeadline = Date.now() + Math.max(5000, timeoutMs - (Date.now() - started))
  const { matches, distinctKeys, costlyTimedOut } = verifyCandidates(candidates, dbHeads, verifyDeadline)
  if (matches.length === 0) return done({ ok: false, error: 'VERIFY_FAILED' })
  steps.push(`verified=${matches.length}/${dbHeads.length} distinctKeys=${distinctKeys}${costlyTimedOut ? ' costly-budget-hit' : ''}`)
  return done({ ok: true, keys: matches, total: dbHeads.length, truncated: Number(parsed.truncated ?? 0) === 1 || costlyTimedOut })
}
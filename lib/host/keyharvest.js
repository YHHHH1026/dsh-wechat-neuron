/**
 * 微信数据库密钥自动提取（Windows / 只读）。
 *
 * 原理（不依赖 salt 出现在内存里）：
 *   微信 4.x 用 SQLCipher 的 raw-key 模式，进程内存中驻留 32 字节原始密钥，
 *   该密钥直接作为 AES-256 密钥使用（不经 PBKDF2）。于是可以「已知明文」反推：
 *     文件 = salt(16B) + 页1体(4080B) + 页2..N(各 4096B)
 *     每页体 = 密文(cipherLen) + IV(16B) + HMAC
 *     cipherLen = bodyLen - reserve，页1 的 bodyLen = 4080
 *     C1 = 文件偏移 16..32（页1 的第一个密文分组）
 *     D_K(C1) 应为「明文偏移 16..32」，即 SQLite 页头续段：
 *       0x10 0x00 | 写版本 | 读版本 | 每页保留字节 | 0x40 0x20 0x20
 *   其中「每页保留字节」各家实现不一致，用掩码屏蔽，只比 7 字节（56 bit），
 *   误报率 1/2^56，再叠加库文件数量与 HMAC 确认，可视为无误报。
 *
 * 因此对内存里任意 32 字节窗口 K，只需 AES-256-ECB 解一个分组即可判定，
 * 命中后用 crypto.js 的 detectAnyProfile 做 HMAC 全量确认。
 */
import { execFile } from 'node:child_process'
import { openSync, readSync, closeSync, statSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAGE_SIZE, SALT_SIZE, detectAnyProfile, probeRawKey } from './crypto.js'

export const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1')
export const KNOWN_PLAIN_HEADER = [0x10, 0x00, 0x01, 0x01]

const PROCESS_NAMES = ['Weixin.exe', 'WeChat.exe', 'WeChatAppEx.exe', 'WeixinApp.exe']
const RESERVES = [80, 48, 64, 32, 16, 12]
const MAX_HITS = 48

/** 只读文件开头 length 字节。 */
export function readHead(path, length = PAGE_SIZE) {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const want = Math.min(length, Math.max(0, size))
    const buffer = Buffer.alloc(want)
    let read = 0
    while (read < want) {
      const got = readSync(fd, buffer, read, want - read, read)
      if (got <= 0) break
      read += got
    }
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/** 读取各库文件头 16 字节 salt（跳过明文库与全 0）。 */
export function readSalts(dbPaths, max = 4) {
  const salts = []
  const seen = new Set()
  for (const path of dbPaths) {
    if (salts.length >= max) break
    if (existsSync(path) === false) continue
    const buffer = readHead(path, SALT_SIZE)
    if (buffer.length < SALT_SIZE) continue
    if (buffer.toString('latin1', 0, 16).startsWith('SQLite format 3')) continue
    if (buffer.every((byte) => byte === 0)) continue
    const hex = buffer.toString('hex')
    if (seen.has(hex)) continue
    seen.add(hex)
    salts.push(Buffer.from(buffer))
  }
  return salts
}

/** 页1 首分组的期望掩码（第 5 字节为「每页保留字节」，屏蔽）。 */
const EXPECTED = [0x10, 0x00, 0x01, 0x01, 0x00, 0x40, 0x20, 0x20]
const EXPECTED_MASK = [0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff]

/** 由库文件头构造「页1 首个明文分组」的期望值（供扫描器比对）。 */
export function buildTargets(head, reserves = RESERVES) {
  if (head.length < PAGE_SIZE) return []
  const c1 = head.subarray(SALT_SIZE, SALT_SIZE + 16)
  const targets = []
  for (const reserve of reserves) {
    const cipherLen = PAGE_SIZE - SALT_SIZE - reserve
    if (cipherLen <= 0) continue
    const ivAt = SALT_SIZE + cipherLen
    if (ivAt + 16 > head.length) continue
    const iv = head.subarray(ivAt, ivAt + 16)
    const target = Buffer.alloc(16)
    const maskBuffer = Buffer.alloc(16)
    for (let i = 0; i < 8; i += 1) {
      target[i] = (EXPECTED[i] ^ iv[i]) & EXPECTED_MASK[i]
      maskBuffer[i] = EXPECTED_MASK[i]
    }
    targets.push({ reserve, c1: c1.toString('hex'), target: target.toString('hex'), mask: maskBuffer.toString('hex') })
  }
  return targets
}

/** 列出正在运行的微信进程 PID（tasklist 优先，失败回退 PowerShell）。 */
export function listWechatPids(timeoutMs = 30000) {
  // 只扫主进程：WeChatAppEx.exe 是 CEF/小程序渲染进程，不开 SQLite、不持有数据库密钥，
  // 扫它们纯属浪费预算（实测 15 进程里 10 个是渲染器）。保留 Weixin/WeChat/WeixinApp 主进程。
  const pattern = /^(?:Weixin|WeChat|WeixinApp)$/i
  const parse = (stdout) => {
    const pids = []
    for (const line of String(stdout).split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const cells = trimmed.split(',').map((cell) => cell.trim())
      if (cells.length < 2) continue
      if (pattern.test(cells[0]) === false) continue
      const pid = Number(cells[1])
      if (Number.isInteger(pid) && pid > 0) pids.push(pid)
    }
    return [...new Set(pids)]
  }
  const run = (file, args) => new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (typeof stdout !== 'string') return resolve([])
      resolve(parse(stdout))
    })
  })
  // 主进程判据：命令行不带 --type=。实测微信 4.1.15.56 有 5 个 Weixin.exe，
  // 其中 4 个是 --type=wxocr/wxutility/xplayer/wxpublic 辅助进程（不开库、不持密钥），
  // 只有无 --type 的那个（本机 PID 16088，482MB）才是持有数据库密钥的主进程。
  // 用 Get-CimInstance 而非 Get-Process：后者拿不到 CommandLine。
  // CommandLine 为 null（权限不足）时 -notmatch 为真 → 保留，宁可多扫不可漏掉主进程。
  const powershellScript = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(Weixin|WeChat|WeixinApp)(\\.exe)?$" -and $_.CommandLine -notmatch "--type=" } | ForEach-Object { ($_.Name -replace "\\.exe$","") + "," + $_.ProcessId }'
  const viaPowerShell = () => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellScript])
  const viaTasklist = () => run('tasklist.exe', ['/FO', 'CSV', '/NH'])
  return viaPowerShell().then((pids) => (pids.length > 0 ? pids : viaTasklist()))
}

const CSHARP = String.raw`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.IO;

public static class WxKeyScan
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MEMORY_BASIC_INFORMATION info, IntPtr length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);

    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint PROCESS_VM_READ = 0x0010;
    const uint MEM_COMMIT = 0x1000;
    const uint MEM_PRIVATE = 0x20000;
    const int SALT_OFFSET = 16;
    const int CHUNK = 4 * 1024 * 1024;
    const int OVERLAP = 1024;

    static readonly byte[] SBOX = BuildSBox();
    static readonly byte[] INV_SBOX = BuildInvSBox();
    static readonly byte[] M9 = BuildMulTable(9);
    static readonly byte[] M11 = BuildMulTable(11);
    static readonly byte[] M13 = BuildMulTable(13);
    static readonly byte[] M14 = BuildMulTable(14);

    static byte RotByte(byte x, int n)
    {
        return (byte)(((x << n) | (x >> (8 - n))) & 0xff);
    }

    static byte GfMul(byte a, byte b)
    {
        int x = a;
        int y = b;
        int r = 0;
        for (int i = 0; i < 8; i++)
        {
            if ((y & 1) != 0) r ^= x;
            bool high = (x & 0x80) != 0;
            x = (x << 1) & 0xff;
            if (high) x ^= 0x1b;
            y >>= 1;
        }
        return (byte)(r & 0xff);
    }

    static byte GfPow(byte a, int n)
    {
        byte r = 1;
        byte baseValue = a;
        int exp = n;
        while (exp > 0)
        {
            if ((exp & 1) != 0) r = GfMul(r, baseValue);
            baseValue = GfMul(baseValue, baseValue);
            exp >>= 1;
        }
        return r;
    }

    static byte[] BuildMulTable(byte factor)
    {
        byte[] table = new byte[256];
        for (int i = 0; i < 256; i++) table[i] = GfMul((byte)i, factor);
        return table;
    }

    static byte[] BuildSBox()
    {
        byte[] table = new byte[256];
        for (int i = 0; i < 256; i++)
        {
            byte inv = i == 0 ? (byte)0 : GfPow((byte)i, 254);
            byte value = (byte)(inv ^ RotByte(inv, 1) ^ RotByte(inv, 2) ^ RotByte(inv, 3) ^ RotByte(inv, 4) ^ 0x63);
            table[i] = value;
        }
        return table;
    }

    static byte[] BuildInvSBox()
    {
        byte[] table = new byte[256];
        for (int i = 0; i < 256; i++) table[SBOX[i]] = (byte)i;
        return table;
    }

    /**
     * AES 密钥扩展。keyLen 支持 16（AES-128，Nk=4，10 轮）与 32（AES-256，Nk=8，14 轮）。
     * WCDB/SQLCipher 的 raw key 两种长度都合法，旧实现只写了 Nk=8，AES-128 的库必然漏检。
     */
    static void ExpandKey(byte[] key, int keyLen, uint[] rk, out int rounds)
    {
        int nk = keyLen / 4;
        rounds = nk + 6;
        int total = 4 * (rounds + 1);
        for (int i = 0; i < nk; i++)
        {
            rk[i] = ((uint)key[4 * i] << 24) | ((uint)key[4 * i + 1] << 16) | ((uint)key[4 * i + 2] << 8) | (uint)key[4 * i + 3];
        }
        uint rcon = 1;
        for (int i = nk; i < total; i++)
        {
            uint t = rk[i - 1];
            if (i % nk == 0)
            {
                t = ((uint)SBOX[(t >> 16) & 0xff] << 24) | ((uint)SBOX[(t >> 8) & 0xff] << 16) | ((uint)SBOX[t & 0xff] << 8) | (uint)SBOX[(t >> 24) & 0xff];
                t = t ^ (rcon << 24);
                rcon = GfMul((byte)rcon, 2);
            }
            else if (nk > 6 && i % nk == 4)
            {
                t = ((uint)SBOX[(t >> 24) & 0xff] << 24) | ((uint)SBOX[(t >> 16) & 0xff] << 16) | ((uint)SBOX[(t >> 8) & 0xff] << 8) | (uint)SBOX[t & 0xff];
            }
            rk[i] = rk[i - nk] ^ t;
        }
    }

    /**
     * 判定窗口内 offset 处的候选密钥长度：先试 32 字节（AES-256），再试 16 字节（AES-128）。
     * 命中返回该长度，未命中返回 0。
     */
    static int ProbeKeyLength(byte[] window, int offset, byte[] c1, HashSet<ulong> patterns, byte[] keyBytes, uint[] rk, byte[] plain, byte[] st)
    {
        int rounds;
        Buffer.BlockCopy(window, offset, keyBytes, 0, 32);
        ExpandKey(keyBytes, 32, rk, out rounds);
        DecryptBlock(rk, rounds, c1, 0, plain, 0, st);
        if (patterns.Contains(PackXor(plain, 0))) return 32;
        ExpandKey(keyBytes, 16, rk, out rounds);
        DecryptBlock(rk, rounds, c1, 0, plain, 0, st);
        if (patterns.Contains(PackXor(plain, 0))) return 16;
        return 0;
    }

    static void AddRoundKey(byte[] st, uint[] rk, int round)
    {
        for (int c = 0; c < 4; c++)
        {
            uint w = rk[round * 4 + c];
            st[4 * c] ^= (byte)(w >> 24);
            st[4 * c + 1] ^= (byte)(w >> 16);
            st[4 * c + 2] ^= (byte)(w >> 8);
            st[4 * c + 3] ^= (byte)w;
        }
    }

    static void InvShiftRows(byte[] s)
    {
        byte t;
        t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
        t = s[2]; s[2] = s[10]; s[10] = t;
        t = s[6]; s[6] = s[14]; s[14] = t;
        t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
    }

    static void InvSubBytes(byte[] s)
    {
        for (int i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    }

    static void InvMixColumns(byte[] s)
    {
        for (int c = 0; c < 16; c += 4)
        {
            byte a0 = s[c];
            byte a1 = s[c + 1];
            byte a2 = s[c + 2];
            byte a3 = s[c + 3];
            s[c] = (byte)(M14[a0] ^ M11[a1] ^ M13[a2] ^ M9[a3]);
            s[c + 1] = (byte)(M9[a0] ^ M14[a1] ^ M11[a2] ^ M13[a3]);
            s[c + 2] = (byte)(M13[a0] ^ M9[a1] ^ M14[a2] ^ M11[a3]);
            s[c + 3] = (byte)(M11[a0] ^ M13[a1] ^ M9[a2] ^ M14[a3]);
        }
    }

    static bool IsHexByte(byte b)
    {
        return (b >= 48 && b <= 57) || (b >= 97 && b <= 102) || (b >= 65 && b <= 70);
    }

    static int HexVal(byte b)
    {
        if (b >= 48 && b <= 57) return b - 48;
        if (b >= 97 && b <= 102) return b - 87;
        return b - 55;
    }

    /**
     * 试一把候选密钥：解首分组 + 布局无关判定，命中则记录并置 found。
     * keyLen 由调用方决定（32=AES-256，16=AES-128）。
     */
    static bool TryCandidateKey(byte[] keyBytes, int keyLen, byte[] c1, HashSet<ulong> patterns, Job job, object gate, uint[] rk, byte[] plain, byte[] st)
    {
        int rounds;
        ExpandKey(keyBytes, keyLen, rk, out rounds);
        DecryptBlock(rk, rounds, c1, 0, plain, 0, st);
        if (patterns.Contains(PackXor(plain, 0)) == false) return false;
        lock (gate)
        {
            if (job.found == 0)
            {
                job.found = 1;
                job.hits++;
                job.keys.Add(BitConverter.ToString(keyBytes, 0, keyLen).Replace("-", "").ToLowerInvariant());
                job.Flush();
            }
        }
        return true;
    }

    /**
     * 微信 4.x 的 raw key 常常以 64 字符十六进制字符串的形式存在于进程内存里。
     * 逐段找出连续的 hex 字符run，取其首/尾 64 字符解码成 32 字节作为候选密钥；
     * 同时取 32 字符窗口按 AES-128 试一遍（WCDB 允许 x'<32hex>' 形态）。
     */
    static void ScanHexRuns(byte[] buffer, int got, byte[] c1, HashSet<ulong> patterns, Job job, object gate, ParallelLoopState state)
    {
        byte[] keyBytes = new byte[32];
        uint[] rk = new uint[60];
        byte[] plain = new byte[16];
        byte[] st = new byte[16];
        int i = 0;
        while (i < got)
        {
            if (!IsHexByte(buffer[i])) { i++; continue; }
            int start = i;
            while (i < got && IsHexByte(buffer[i])) i++;
            int len = i - start;
            if (len >= 32 && len < 64)
            {
                string word = Encoding.ASCII.GetString(buffer, start, 32).ToLowerInvariant();
                lock (gate)
                {
                    if (job.words.Count < 400 && job.seenWords.Add(word)) job.words.Add(word);
                }
                continue;
            }
            if (len < 64) continue;
            List<int> positionList = new List<int>();
            if (len == 64) positionList.Add(start);
            else
            {
                for (int p = start; p + 64 <= start + len; p += 64) positionList.Add(p);
                positionList.Add(start + len - 64);
            }
            int[] positions = positionList.ToArray();
            foreach (int p in positions)
            {
                for (int k = 0; k < 32; k++) keyBytes[k] = (byte)((HexVal(buffer[p + k * 2]) << 4) | HexVal(buffer[p + k * 2 + 1]));
                if (TryCandidateKey(keyBytes, 32, c1, patterns, job, gate, rk, plain, st)) { state.Stop(); return; }
                // 同一位置的 32 字符前缀按 AES-128 再试一次
                for (int k = 0; k < 16; k++) keyBytes[k] = (byte)((HexVal(buffer[p + k * 2]) << 4) | HexVal(buffer[p + k * 2 + 1]));
                if (TryCandidateKey(keyBytes, 16, c1, patterns, job, gate, rk, plain, st)) { state.Stop(); return; }
            }
        }
    }

    /**
     * 微信 4.x 常把 raw key 以 UTF-16LE 字符串保存（hex 字符 + 0x00 交织）。
     * 这里按「字符 + 0」的节奏再扫一遍，取每个 64 字符窗口解码成 32 字节。
     */
    static void ScanHexRunsWide(byte[] buffer, int got, byte[] c1, HashSet<ulong> patterns, Job job, object gate, ParallelLoopState state)
    {
        byte[] keyBytes = new byte[32];
        uint[] rk = new uint[60];
        byte[] plain = new byte[16];
        byte[] st = new byte[16];
        int i = 0;
        while (i + 1 < got)
        {
            if (!IsHexByte(buffer[i]) || buffer[i + 1] != 0) { i++; continue; }
            int start = i;
            int chars = 0;
            while (i + 1 < got && IsHexByte(buffer[i]) && buffer[i + 1] == 0) { i += 2; chars++; }
            if (chars >= 32 && chars < 64)
            {
                char[] charsArr = new char[32];
                for (int k = 0; k < 32; k++) charsArr[k] = (char)buffer[start + k * 2];
                string word = new string(charsArr).ToLowerInvariant();
                lock (gate)
                {
                    if (job.words.Count < 400 && job.seenWords.Add(word)) job.words.Add(word);
                }
                continue;
            }
            if (chars < 64) continue;
            List<int> positionList = new List<int>();
            int span = chars * 2;
            if (chars == 64) positionList.Add(start);
            else
            {
                for (int p = start; p + 128 <= start + span; p += 128) positionList.Add(p);
                positionList.Add(start + span - 128);
            }
            foreach (int p in positionList)
            {
                for (int k = 0; k < 32; k++) keyBytes[k] = (byte)((HexVal(buffer[p + k * 4]) << 4) | HexVal(buffer[p + k * 4 + 2]));
                if (TryCandidateKey(keyBytes, 32, c1, patterns, job, gate, rk, plain, st)) { state.Stop(); return; }
                for (int k = 0; k < 16; k++) keyBytes[k] = (byte)((HexVal(buffer[p + k * 4]) << 4) | HexVal(buffer[p + k * 4 + 2]));
                if (TryCandidateKey(keyBytes, 16, c1, patterns, job, gate, rk, plain, st)) { state.Stop(); return; }
            }
        }
    }

    /**
     * 补一种尚未覆盖的密钥形态：宽字符数组（每个 wchar 只存 1 字节，32 字节分散在 64 字节上、步长 2）。
     */
    static void ScanByteStride2(byte[] buffer, int got, byte[] c1, HashSet<ulong> patterns, Job job, object gate, ParallelLoopState state)
    {
        byte[] keyBytes = new byte[32];
        uint[] rk = new uint[60];
        byte[] plain = new byte[16];
        byte[] st = new byte[16];
        for (int i = 0; i + 64 <= got; i++)
        {
            // 宽字符密钥的必要条件：32 个「字符字节」之后的奇数位必须全为 0x00。
            // 随机内存几乎不可能满足（通过率约 1/2^8 起步、整体 ~1/65536），
            // 而原实现对每个字节偏移都跑一次完整 AES-256（4MB chunk = 400 万次），
            // 是 0.67MB/s 慢扫的真正主因。先做这个零漏检预过滤，把 AES 量降约 6 万倍。
            bool ok = true;
            for (int k = 0; k < 32; k++) { if (buffer[i + k * 2 + 1] != 0) { ok = false; break; } }
            if (!ok) continue;
            for (int k = 0; k < 32; k++) keyBytes[k] = buffer[i + k * 2];
            if (TryCandidateKey(keyBytes, 32, c1, patterns, job, gate, rk, plain, st)) { state.Stop(); return; }
        }
    }

    /**
     * 与 reserve 无关的明文头判定：解密出的首分组必须是
     *   a) 微信 4.x 的 SQLite 页头 0x10 0x00 + 读写版本(1..2)/每页保留字节 / 0x40 0x20 0x20
     *   b) 或标准 SQLite 文件头 "SQLi"
     * 这样就不需要预先知道 reserve，避免因 reserve 猜错而永远 0 命中。
     */
    static bool LooksHeader(byte[] p)
    {
        if (p[0] == 0x10 && p[1] == 0x00 && p[2] >= 1 && p[2] <= 2 && p[3] >= 1 && p[3] <= 2) return true;
        if (p[0] == 0x53 && p[1] == 0x51 && p[2] == 0x4c && p[3] == 0x69) return true;
        return false;
    }

    /**
     * 页 1 明文的头 8 字节是已知的：0x10,0x00,1,1,<每页保留字节>,0x40,0x20,0x20。
     * 第 5 字节随 SQLCipher 版本变化，比对时跳过，只比 7 字节（56 bit）。
     */
    static readonly byte[] HeaderExpected = new byte[] { 0x10, 0x00, 0x01, 0x01, 0x00, 0x40, 0x20, 0x20 };

    /** 把 b[off..off+8) 按「跳过第 4 字节」打包成 56 bit 整数（不异或）。 */
    static ulong PackRaw(byte[] b, int off)
    {
        ulong v = 0;
        v = (v << 8) | b[off + 0];
        v = (v << 8) | b[off + 1];
        v = (v << 8) | b[off + 2];
        v = (v << 8) | b[off + 3];
        v = (v << 8) | b[off + 5];
        v = (v << 8) | b[off + 6];
        v = (v << 8) | b[off + 7];
        return v;
    }

    /** 把解密结果按「跳过第 4 字节」打包，并与已知明文页头异或。 */
    static ulong PackXor(byte[] b, int off)
    {
        ulong v = 0;
        for (int i = 0; i < 8; i++)
        {
            if (i == 4) continue;
            v = (v << 8) | (byte)(b[off + i] ^ HeaderExpected[i]);
        }
        return v;
    }

    /**
     * 核心判定（与 SQLCipher 布局/每页保留字节完全无关）：
     * CBC 下 D_K(C1) = P1 XOR IV，而 IV 一定作为 16 字节明文写在库文件的第 1 页里。
     * 因此 (D_K(C1) XOR P1_known) 必须等于 IV 的前 7 字节 —— 也就是必须能在库文件头里
     * 找到一段完全相同的 7 字节。命中即说明 K 就是 raw key。
     * 这样就不必猜 reserve/IV 偏移，彻底消除「猜错布局 -> 永远 0 命中」的死路。
     */
    // WAL 模式（微信 4.x 实测：每个库都有 .db-wal/.db-shm，WAL 头 magic 377f0682）下，
    // SQLite 页头写/读版本字节是 2/2 而非 rollback 的 1/1。PackXor 以 HeaderExpected(版本=1)
    // 为基准，若只存 PackRaw 会把正确的 WAL 密钥判否（这正是历史 7.3 亿候选 0 命中的根因）。
    // 修法：对每个 IV 窗口额外存入「版本位翻转」变体。delta 仅作用于打包后的写版本(第3字节,
    // 左移32)与读版本(第4字节,左移24)，1⊕2=3。单次 PackXor+Contains 即同时覆盖 1/1 与 2/2，
    // 热循环零额外 AES 开销；误报率由 1/2^56 升到 2/2^56，仍可忽略，且后续有 HMAC 全量确认。
    static readonly ulong VersionDelta = (3UL << 32) | (3UL << 24);
    static HashSet<ulong> BuildPatternSet(byte[] head)
    {
        HashSet<ulong> set = new HashSet<ulong>();
        int limit = head.Length - 8;
        for (int off = 16; off <= limit; off++)
        {
            ulong raw = PackRaw(head, off);
            set.Add(raw);
            set.Add(raw ^ VersionDelta);
        }
        return set;
    }

    static void DecryptBlock(uint[] rk, int rounds, byte[] src, int srcOffset, byte[] dst, int dstOffset, byte[] st)
    {
        for (int i = 0; i < 16; i++) st[i] = src[srcOffset + i];
        AddRoundKey(st, rk, rounds);
        for (int round = rounds - 1; round >= 1; round--)
        {
            InvShiftRows(st);
            InvSubBytes(st);
            AddRoundKey(st, rk, round);
            InvMixColumns(st);
        }
        InvShiftRows(st);
        InvSubBytes(st);
        AddRoundKey(st, rk, 0);
        for (int i = 0; i < 16; i++) dst[dstOffset + i] = st[i];
    }

    static bool Readable(uint protect)
    {
        if ((protect & 0x100) != 0) return false;
        if ((protect & 0x01) != 0) return false;
        uint basic = protect & 0xff;
        return basic == 0x02 || basic == 0x04 || basic == 0x08 || basic == 0x10 || basic == 0x20 || basic == 0x40 || basic == 0x80;
    }

    class Job
    {
        public List<string> keys = new List<string>();
        public long scanned = 0;
        public long tested = 0;
        public long readFails = 0;
        public List<string> words = new List<string>();
        public HashSet<string> seenWords = new HashSet<string>();
        public int hits = 0;
        public int found = 0;
        public int regionsDone = 0;
        public int exhausted = 0;
        public int truncated = 0;
        public int level = 0;
        public int levels = 0;
        public string outPath;
        public StringBuilder regions = new StringBuilder();

        public void Flush()
        {
            StringBuilder json = new StringBuilder();
            json.Append("{\"keys\":[");
            for (int i = 0; i < keys.Count; i++)
            {
                if (i > 0) json.Append(',');
                json.Append('"').Append(keys[i]).Append('"');
            }
            json.Append("],\"scanned\":").Append(Interlocked.Read(ref scanned));
            json.Append(",\"tested\":").Append(Interlocked.Read(ref tested));
            json.Append(",\"readFails\":").Append(Interlocked.Read(ref readFails));
            json.Append(",\"hits\":").Append(hits);
            json.Append(",\"exhausted\":").Append(exhausted);
            json.Append(",\"truncated\":").Append(truncated);
            json.Append(",\"level\":").Append(level);
            json.Append(",\"levels\":").Append(levels);
            json.Append(",\"words\":[");
            for (int i = 0; i < words.Count; i++)
            {
                if (i > 0) json.Append(',');
                json.Append('"').Append(words[i]).Append('"');
            }
            json.Append("],\"regions\":\"").Append(regions.ToString()).Append("\"}");
            lock (this) { try { File.WriteAllText(outPath, json.ToString(), new UTF8Encoding(false)); } catch { } }
        }
    }

    static byte[] Hex(string text)
    {
        if (text == null) return new byte[0];
        string clean = text.Trim();
        if (clean.Length % 2 != 0) return new byte[0];
        byte[] result = new byte[clean.Length / 2];
        for (int i = 0; i < result.Length; i++)
        {
            result[i] = Convert.ToByte(clean.Substring(i * 2, 2), 16);
        }
        return result;
    }

    public static string Run(string headHex, string targetCsv, string pidCsv, int stride, string outPath, int budgetMb, int maxDegree)
    {
        byte[] head = Hex(headHex);
        if (head.Length < 4096) return "no-head";
        byte[] c1 = new byte[16];
        Array.Copy(head, SALT_OFFSET, c1, 0, 16);

        List<byte[]> targets = new List<byte[]>();
        List<byte[]> masks = new List<byte[]>();
        foreach (string part in targetCsv.Split(';'))
        {
            string[] cells = part.Split('=');
            if (cells.Length != 3) continue;
            byte[] target = Hex(cells[1]);
            byte[] mask = Hex(cells[2]);
            if (target.Length < 8 || mask.Length < 8) continue;
            targets.Add(target);
            masks.Add(mask);
        }
        int targetCount = targets.Count;
        if (targetCount == 0) return "no-target";
        if (stride < 1) stride = 1;

        HashSet<ulong> patterns = BuildPatternSet(head);
        if (patterns.Count == 0) return "no-pattern";

        Job job = new Job();
        job.outPath = outPath;
        job.Flush();

        List<int> pids = new List<int>();
        foreach (string token in pidCsv.Split(','))
        {
            int pid;
            if (int.TryParse(token.Trim(), out pid) && pid > 0) pids.Add(pid);
        }
        if (pids.Count == 0) return "no-pid";

        IntPtr[] handles = new IntPtr[pids.Count];
        List<long[]> privRegions = new List<long[]>();
        List<long[]> otherRegions = new List<long[]>();
        for (int h = 0; h < pids.Count; h++)
        {
            handles[h] = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pids[h]);
            if (handles[h] == IntPtr.Zero)
            {
                job.regions.Append(pids[h] + ":open-failed-" + Marshal.GetLastWin32Error() + ";");
                continue;
            }
            long address = 0x10000;
            while (address < 0x7FFFFFFF0000L)
            {
                MEMORY_BASIC_INFORMATION info;
                if (VirtualQueryEx(handles[h], new IntPtr(address), out info, new IntPtr(Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION)))) == IntPtr.Zero) break;
                long regionSize = info.RegionSize.ToInt64();
                long baseAddress = info.BaseAddress.ToInt64();
                if (regionSize <= 0) break;
                if (info.State == MEM_COMMIT && Readable(info.Protect) && regionSize <= 2048L * 1024 * 1024)
                {
                    long[] region = new long[] { h, baseAddress, regionSize };
                    if (info.Type == MEM_PRIVATE) privRegions.Add(region);
                    else otherRegions.Add(region);
                }
                address = baseAddress + regionSize;
            }
        }

        List<long[]> regions = new List<long[]>();
        regions.AddRange(privRegions);
        regions.AddRange(otherRegions);
        job.regions.Append("priv=" + privRegions.Count + " other=" + otherRegions.Count + ";");

        object gate = new object();

        // 分级预算：先扫小页（成本低、命中率最高的常驻结构），再逐级放宽。
        // 每级都有「区段大小上限 + 总读取字节预算 + 并发上限」，绝不无界全扫。
        int[] levelStride = new int[] { Math.Max(1, stride * 4), Math.Max(1, stride * 2), stride };
        long[] levelRegionCap = new long[] { 16L * 1024 * 1024, 256L * 1024 * 1024, long.MaxValue };
        long[] levelBudget = new long[] { 128L * 1024 * 1024, 512L * 1024 * 1024, (long)Math.Max(64, budgetMb) * 1024 * 1024 };
        job.levels = levelStride.Length;
        int degree = Math.Max(1, Math.Min(4, maxDegree));

        for (int lv = 0; lv < levelStride.Length; lv++)
        {
            if (Volatile.Read(ref job.found) == 1) break;
            job.level = lv + 1;
            List<long[]> scope = new List<long[]>();
            foreach (long[] region in regions)
            {
                if (region[2] <= levelRegionCap[lv]) scope.Add(region);
            }
            if (scope.Count == 0) { job.Flush(); continue; }
            // 小页段优先：命中通常出现在小的私有堆块里
            scope.Sort((a, b) => a[2].CompareTo(b[2]));
            int curStride = levelStride[lv];
            long budget = levelBudget[lv];
            long before = Interlocked.Read(ref job.scanned);
            int[] cutFlag = new int[1];

            Parallel.ForEach(scope, new ParallelOptions { MaxDegreeOfParallelism = degree }, (region, state) =>
            {
                if (Volatile.Read(ref job.found) == 1) { state.Stop(); return; }
                if (Interlocked.Read(ref job.scanned) - before >= budget) { Interlocked.Exchange(ref cutFlag[0], 1); state.Stop(); return; }
                IntPtr handle = handles[(int)region[0]];
                long baseAddress = region[1];
                long regionSize = region[2];
                byte[] buffer = new byte[CHUNK + OVERLAP];
                byte[] plain = new byte[16];
                byte[] keyBytes = new byte[32];
                byte[] state16 = new byte[16];
                uint[] rk = new uint[60];
                long testedHere = 0;
                for (long offset = 0; offset < regionSize; offset += CHUNK)
                {
                    if (Volatile.Read(ref job.found) == 1) break;
                    if (Interlocked.Read(ref job.scanned) - before >= budget) { Interlocked.Exchange(ref cutFlag[0], 1); break; }
                    int want = (int)Math.Min(CHUNK, regionSize - offset);
                    IntPtr read;
                    if (ReadProcessMemory(handle, new IntPtr(baseAddress + offset), buffer, new IntPtr(want), out read) == false) { Interlocked.Add(ref job.readFails, 1); continue; }
                    int got = (int)read.ToInt64();
                    if (got < 40) continue;
                    Interlocked.Add(ref job.scanned, got);
                    for (int i = 0; i + 32 <= got; i += curStride)
                    {
                        testedHere++;
                        int hitLen = ProbeKeyLength(buffer, i, c1, patterns, keyBytes, rk, plain, state16);
                        if (hitLen == 0) continue;
                        lock (gate)
                        {
                            if (job.found == 0)
                            {
                                job.found = 1;
                                job.hits++;
                                job.keys.Add(BitConverter.ToString(keyBytes, 0, hitLen).Replace("-", "").ToLowerInvariant());
                                job.Flush();
                            }
                        }
                        state.Stop();
                        return;
                    }
                    Interlocked.Add(ref job.tested, testedHere);
                    testedHere = 0;
                    ScanHexRuns(buffer, got, c1, patterns, job, gate, state);
                    ScanHexRunsWide(buffer, got, c1, patterns, job, gate, state);
                    ScanByteStride2(buffer, got, c1, patterns, job, gate, state);
                    if (Volatile.Read(ref job.found) == 1) break;
                }
                Interlocked.Add(ref job.tested, testedHere);
                if (Interlocked.Increment(ref job.regionsDone) % 24 == 0) job.Flush();
            });

            if (cutFlag[0] == 1) Interlocked.Exchange(ref job.truncated, 1);
            job.Flush();
            if (Volatile.Read(ref job.found) == 1) break;
        }

        // exhausted=1 表示「所有级别的预算内区域都扫完了仍无命中」，
        // 这是 NO_CANDIDATE；exhausted=0 说明预算/超时先到，应报 TIMEOUT。
        if (Volatile.Read(ref job.found) == 0 && Volatile.Read(ref job.truncated) == 0) job.exhausted = 1;

        for (int h = 0; h < handles.Length; h++)
        {
            if (handles[h] != IntPtr.Zero) CloseHandle(handles[h]);
        }
        job.Flush();
        return "done";
    }
}
`

function runPowerShell(script, timeoutMs, scriptFile = null) {
  return new Promise((resolve) => {
    if (scriptFile !== null) {
      // 长脚本走临时 .ps1：-EncodedCommand 会被 Windows 命令行长度上限截断（ENAMETOOLONG）。
      // 必须带 UTF-8 BOM，否则 Windows PowerShell 5.1 会按 ANSI 解码，中文注释乱码后破坏 C# 源码。
      writeFileSync(scriptFile, `\ufeff${script}`, { encoding: 'utf8' })
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
        },
      )
      return
    }
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
      },
    )
  })
}

/**
 * 在给定内存窗口里逐个偏移尝试 32 字节候选（salt 邻近假设）。
 * 用 probeRawKey 做单分组快筛，命中后再用 detectAnyProfile 做 HMAC 确认。
 */
export function scanWindow(window, head, options = {}) {
  const stride = Number.isInteger(options.stride) ? Math.max(1, options.stride) : 1
  const limit = Number.isInteger(options.limit) ? options.limit : 200000
  const keep = Number.isInteger(options.keep) ? options.keep : 8
  let tested = 0
  const hits = []
  for (let offset = 0; offset + 32 <= window.length; offset += stride) {
    if (tested >= limit) break
    tested += 1
    const key = window.subarray(offset, offset + 32)
    const layout = probeRawKey(head, key)
    if (layout === null) continue
    const detected = detectAnyProfile(head, key)
    if (detected !== null) {
      return { key: key.toString('hex'), profile: detected.profile.id, tested, hits }
    }
    // 单分组命中但 HMAC 未通过：可能是 MAC 参数不符，先留作候选。
    if (hits.length < keep) hits.push({ key: key.toString('hex'), layout })
  }
  return { key: null, tested, hits }
}

/**
 * 口令型候选（32 字符字符串）走 PBKDF2 派生，命中则返回口令本身。
 * 有界化：每个候选要走多个参数族的 PBKDF2（含 256k 迭代），上百个候选 × 多库
 * 会组合爆炸挂死几十分钟。这里 ① 去重 ② 同一账号各库共享密钥，只用首个有效库做代表
 * ③ 全局截止时间兜底，超时即返回未命中（交由上层判 TIMEOUT/NO_CANDIDATE）。
 */
export function validatePassphrases(candidates, dbPaths, deadlineMs = 20000) {
  const deadline = Date.now() + Math.max(1000, Number(deadlineMs) || 20000)
  const seen = new Set()
  // 同一账号的所有库共享同一把密钥：取首个能读到完整首页的库做代表即可，
  // 避免对 6 个库重复跑同一批候选（6× 浪费）。
  let head = null
  let repPath = null
  for (const path of dbPaths) {
    if (existsSync(path) === false) continue
    const h = readHead(path, PAGE_SIZE * 2)
    if (h.length < PAGE_SIZE) continue
    head = h
    repPath = path
    break
  }
  if (head === null) return { ok: false }
  for (const candidate of candidates) {
    if (Date.now() > deadline) return { ok: false, timedOut: true }
    const word = String(candidate ?? '')
    if (word.length < 6 || seen.has(word)) continue
    seen.add(word)
    const detected = detectAnyProfile(head, Buffer.from(word, 'utf8'))
    if (detected === null) continue
    return { ok: true, key: word, profile: detected.profile.id, file: repPath, passphrase: true }
  }
  return { ok: false }
}

/** 用候选密钥逐个尝试解密，成功则返回 {key, profile, file}。 */
export function validateCandidates(candidates, dbPaths) {
  for (const path of dbPaths) {
    if (existsSync(path) === false) continue
    const head = readHead(path, PAGE_SIZE * 2)
    if (head.length < PAGE_SIZE) continue
    for (const candidate of candidates) {
      const key = Buffer.from(candidate, 'hex')
      // WCDB 的 raw key 可以是 16 字节（AES-128）或 32 字节（AES-256）
      if (key.length !== 16 && key.length !== 32) continue
      if (probeRawKey(head, key) === null) continue
      const detected = detectAnyProfile(head, key)
      if (detected === null) continue
      return { ok: true, key: candidate, profile: detected.profile.id, file: path }
    }
  }
  return { ok: false }
}

function readCache(cacheFile) {
  try {
    if (existsSync(cacheFile) === false) return null
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (typeof parsed.key !== 'string' || parsed.key.length !== 64) return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(cacheFile, value) {
  try {
    writeFileSync(cacheFile, JSON.stringify(value, null, 2), 'utf8')
  } catch {
    // 缓存写失败不影响主流程
  }
}

/**
 * 自动提取微信数据库密钥。
 * @param {{dbPaths:string[], pids?:number[], stride?:number, timeoutMs?:number, cacheFile?:string, skipCache?:boolean}} options
 */
export async function harvestKey(options) {
  const started = Date.now()
  const dbPaths = Array.isArray(options?.dbPaths) ? options.dbPaths.filter((p) => typeof p === 'string' && p.length > 0) : []
  const stride = Number.isInteger(options?.stride) ? Math.max(1, Math.min(16, options.stride)) : 4
  const timeoutMs = Number.isInteger(options?.timeoutMs) ? options.timeoutMs : 150000
  // 分级预算的第三级上限与并发上限：并发只开到 2，避免高负载把系统拖垮。
  const budgetMb = Number.isInteger(options?.budgetMb) ? Math.max(64, Math.min(4096, options.budgetMb)) : 512
  const maxDegree = Number.isInteger(options?.maxDegree) ? Math.max(1, Math.min(4, options.maxDegree)) : 2
  const cacheFile = typeof options?.cacheFile === 'string' ? options.cacheFile : null
  const steps = []
  const done = (payload) => ({ ...payload, steps, elapsedMs: Date.now() - started })

  if (dbPaths.length === 0) return done({ ok: false, error: 'NO_DB' })

  let head = null
  let headFile = null
  for (const path of dbPaths) {
    if (existsSync(path) === false) continue
    const buffer = readHead(path, PAGE_SIZE)
    if (buffer.length < PAGE_SIZE) continue
    head = buffer
    headFile = path
    break
  }
  if (head === null) return done({ ok: false, error: 'NO_DB' })

  // 页大小校验：SQLCipher 默认 4096，文件长度必须是页大小整数倍。
  // 微信 4.x 都是 4096；其它页大小（如 1024/8192）本实现不支持，明确报 UNSUPPORTED_VERSION 而不是静默 0 命中。
  try {
    const size = statSync(headFile).size
    if (size < PAGE_SIZE || size % PAGE_SIZE !== 0) {
      steps.push('pageSize=unsupported size=' + size)
      return done({ ok: false, error: 'UNSUPPORTED_VERSION' })
    }
  } catch {
    // 读不到大小就继续，交给后续步骤判断
  }

  const targets = buildTargets(head)
  if (targets.length === 0) return done({ ok: false, error: 'NO_LAYOUT' })
  steps.push(`targets=${targets.map((t) => t.reserve).join('/')}`)

  if (cacheFile !== null && options?.skipCache !== true) {
    const cached = readCache(cacheFile)
    if (cached !== null) {
      const key = Buffer.from(cached.key, 'hex')
      const detected = detectAnyProfile(head, key)
      if (detected !== null) {
        steps.push(`cache=hit profile=${detected.profile.id}`)
        return done({ ok: true, key: cached.key, profile: detected.profile.id, source: 'cache', file: headFile })
      }
      steps.push('cache=stale')
    }
  }

  const pids = Array.isArray(options?.pids) && options.pids.length > 0 ? options.pids : await listWechatPids()
  if (pids.length === 0) return done({ ok: false, error: 'NO_PROCESS' })
  steps.push(`pids=${pids.join(',')}`)

  const tempDir = mkdtempSync(join(tmpdir(), 'wxkey-'))
  const debugFile = typeof options?.debugFile === 'string' ? options.debugFile : null
  const outFile = debugFile !== null ? debugFile : join(tempDir, 'scan.json')
  const scriptFile = join(tempDir, 'scan.ps1')
  const outFileArg = outFile.split('\\').join('/')
  const targetCsv = targets.map((t) => `${t.reserve}=${t.target}=${t.mask}`).join(';')
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$src = @'`,
    CSHARP,
    `'@`,
    'Add-Type -TypeDefinition $src -Language CSharp',
    "    $null = [WxKeyScan]::Run('" + head.toString('hex') + "', '" + targetCsv + "', '" + pids.join(',') + "', " + stride + ", '" + outFileArg + "', " + budgetMb + ", " + maxDegree + ")",
    'exit 0',
  ].join('\n')

  let scanned = 0
  let tested = 0
  let keys = []
  let words = []
  let exhausted = false
  let truncated = false
  let level = 0
  let levels = 0
  try {
    const result = await runPowerShell(script, timeoutMs, scriptFile)
    // 超时也可能已经 flush 出结果，因此无论 ok 与否都先读文件。
    if (existsSync(outFile) === true) {
      let parsed = null
      try { parsed = JSON.parse(readFileSync(outFile, 'utf8')) } catch { parsed = null }
      if (parsed !== null) {
        keys = Array.isArray(parsed.keys) ? parsed.keys : []
    words = Array.isArray(parsed.words) ? parsed.words : []
        scanned = Number(parsed.scanned ?? 0)
        tested = Number(parsed.tested ?? 0)
        const regions = typeof parsed.regions === 'string' ? parsed.regions : ''
        const readFails = Number(parsed.readFails ?? 0)
        exhausted = Number(parsed.exhausted ?? 0) === 1
        truncated = Number(parsed.truncated ?? 0) === 1
        level = Number(parsed.level ?? 0)
        levels = Number(parsed.levels ?? 0)
        steps.push(`scanned=${Math.round(scanned / 1048576)}MB tested=${tested} hits=${Number(parsed.hits ?? 0)} readFails=${readFails} level=${level}/${levels}`)
        if (regions !== '') steps.push(`regions=${regions.slice(0, 300)}`)
      }
    }
    const stderr = String(result.stderr ?? '')
    if (stderr.trim() !== '') steps.push(`ps=${stderr.trim().split('\n')[0].slice(0, 200)}`)
  } catch (error) {
    steps.push(`scan=threw ${String(error && error.message)}`)
    return done({ ok: false, error: 'SCAN_FAILED', scanned })
  } finally {
    if (debugFile === null) {
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  let verified = keys.length > 0 ? validateCandidates(keys, dbPaths) : { ok: false }
  if (verified.ok !== true && words.length > 0) verified = validatePassphrases(words, dbPaths)
  if (verified.ok !== true) {
    steps.push(`verify=${keys.length === 0 ? 'no-candidate' : 'failed'} candidates=${keys.length}`)
    // 没命中时区分两种情形：预算内扫完了（真没有） vs 预算/超时先到（还有没扫的地方）。
    const code = keys.length > 0 ? 'VERIFY_FAILED' : (truncated === true || exhausted === false ? 'TIMEOUT' : 'NO_CANDIDATE')
    return done({ ok: false, error: code, scanned, tested, exhausted, truncated, level, levels })
  }
  steps.push(`verified profile=${verified.profile}`)
  if (cacheFile !== null) writeCache(cacheFile, { key: verified.key, profile: verified.profile, file: verified.file, at: new Date().toISOString() })
  return done({ ok: true, key: verified.key, profile: verified.profile, source: 'memory', file: verified.file, scanned, tested, level, levels })
}

// douyin-sign.js —— 抖音 a_bogus（AB-Log）签名，移植自 iGaoMu/ihmily streamget
// platforms/douyin/ab_sign.py。算法全程按字节数组运算，避免 JS 字符串编码副作用。
// 随机串部分与参考实现一致（固定值），时间戳按参考实现计算，签名可复现。

function leftRotate(x, n) {
  n = n % 32;
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function getTJ(j) {
  return 0 <= j && j < 16 ? 2043430169 : 2055708042; // 0x79CC4519 / 0x7A879D8A
}
function ffJ(j, x, y, z) {
  if (0 <= j && j < 16) return (x ^ y ^ z) >>> 0;
  return ((x & y) | (x & z) | (y & z)) >>> 0;
}
function ggJ(j, x, y, z) {
  if (0 <= j && j < 16) return (x ^ y ^ z) >>> 0;
  return ((x & y) | (~x & z)) >>> 0;
}

class SM3 {
  reset() {
    this.reg = [1937774191, 1226093241, 388252375, 3666478592,
      2842636476, 372324522, 3817729613, 2969243214];
    this.chunk = [];
    this.size = 0;
  }
  write(data) {
    const a = typeof data === 'string' ? [...Buffer.from(data, 'utf8')] : [...data];
    this.size += a.length;
    const f = 64 - this.chunk.length;
    if (a.length < f) {
      for (const x of a) this.chunk.push(x);
      return;
    }
    for (let i = 0; i < f; i++) this.chunk.push(a[i]);
    let f2 = f;
    while (this.chunk.length >= 64) {
      this._compress(this.chunk);
      if (f2 < a.length) this.chunk = a.slice(f2, Math.min(f2 + 64, a.length));
      else this.chunk = [];
      f2 += 64;
    }
  }
  _fill() {
    const bit_length = 8 * this.size;
    let padding_pos = this.chunk.length;
    this.chunk.push(0x80);
    padding_pos = (padding_pos + 1) % 64;
    if (64 - padding_pos < 8) padding_pos -= 64;
    while (padding_pos < 56) { this.chunk.push(0); padding_pos += 1; }
    const high_bits = Math.floor(bit_length / 4294967296);
    for (let i = 0; i < 4; i++) this.chunk.push((high_bits >> (8 * (3 - i))) & 0xFF);
    for (let i = 0; i < 4; i++) this.chunk.push((bit_length >> (8 * (3 - i))) & 0xFF);
  }
  _compress(data) {
    const w = new Array(132).fill(0);
    for (let t = 0; t < 16; t++) {
      w[t] = (((data[4 * t] << 24) | (data[4 * t + 1] << 16) | (data[4 * t + 2] << 8) | data[4 * t + 3])) >>> 0;
    }
    for (let j = 16; j < 68; j++) {
      let a = (w[j - 16] ^ w[j - 9] ^ leftRotate(w[j - 3], 15)) >>> 0;
      a = (a ^ leftRotate(a, 15) ^ leftRotate(a, 23)) >>> 0;
      w[j] = (a ^ leftRotate(w[j - 13], 7) ^ w[j - 6]) >>> 0;
    }
    for (let j = 0; j < 64; j++) w[j + 68] = (w[j] ^ w[j + 4]) >>> 0;
    let a = this.reg[0], b = this.reg[1], c = this.reg[2], d = this.reg[3];
    let e = this.reg[4], f = this.reg[5], g = this.reg[6], h = this.reg[7];
    for (let j = 0; j < 64; j++) {
      const ss1 = leftRotate(((leftRotate(a, 12) + e + leftRotate(getTJ(j), j)) >>> 0), 7);
      const ss2 = (ss1 ^ leftRotate(a, 12)) >>> 0;
      const tt1 = (ffJ(j, a, b, c) + d + ss2 + w[j + 68]) >>> 0;
      const tt2 = (ggJ(j, e, f, g) + h + ss1 + w[j]) >>> 0;
      d = c; c = leftRotate(b, 9); b = a; a = tt1;
      h = g; g = leftRotate(f, 19); f = e;
      e = (tt2 ^ leftRotate(tt2, 9) ^ leftRotate(tt2, 17)) >>> 0;
    }
    this.reg[0] = (this.reg[0] ^ a) >>> 0;
    this.reg[1] = (this.reg[1] ^ b) >>> 0;
    this.reg[2] = (this.reg[2] ^ c) >>> 0;
    this.reg[3] = (this.reg[3] ^ d) >>> 0;
    this.reg[4] = (this.reg[4] ^ e) >>> 0;
    this.reg[5] = (this.reg[5] ^ f) >>> 0;
    this.reg[6] = (this.reg[6] ^ g) >>> 0;
    this.reg[7] = (this.reg[7] ^ h) >>> 0;
  }
  sum(data, outputFormat) {
    if (data !== undefined && data !== null) { this.reset(); this.write(data); }
    this._fill();
    for (let f = 0; f + 64 <= this.chunk.length; f += 64) {
      this._compress(this.chunk.slice(f, f + 64));
    }
    // prettier-ignore
    const result = [];
    for (let r = 0; r < 8; r++) {
      const v = this.reg[r];
      result.push((v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
    }
    this.reset();
    return result;
  }
}

function rc4(data, key) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let i = 0; j = 0;
  const out = [];
  for (const ch of data) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out.push(s[(s[i] + s[j]) & 255] ^ ch);
  }
  return out;
}

const ENC = {
  s0: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',
  s1: 'Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=',
  s2: 'Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=',
  s3: 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe',
  s4: 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe',
};
const MASKS = [16515072, 258048, 4032, 63];
const SHIFTS = [18, 12, 6, 0];

function getLongInt(roundNum, bytes) {
  const r = roundNum * 3;
  const c1 = r < bytes.length ? bytes[r] : 0;
  const c2 = r + 1 < bytes.length ? bytes[r + 1] : 0;
  const c3 = r + 2 < bytes.length ? bytes[r + 2] : 0;
  return ((c1 << 16) | (c2 << 8) | c3) >>> 0;
}

function resultEncrypt(bytes, num) {
  const table = ENC[num];
  let roundNum = 0;
  let li = getLongInt(0, bytes);
  const total = Math.ceil((bytes.length / 3) * 4);
  let res = '';
  for (let i = 0; i < total; i++) {
    if (Math.floor(i / 4) !== roundNum) { roundNum += 1; li = getLongInt(roundNum, bytes); }
    const index = i % 4;
    const ci = (li & MASKS[index]) >>> SHIFTS[index];
    res += table[ci];
  }
  return res;
}

function generRandom(randomNum, option) {
  const byte1 = randomNum & 255;
  const byte2 = (randomNum >> 8) & 255;
  return [
    (byte1 & 170) | (option[0] & 85),
    (byte1 & 85) | (option[0] & 170),
    (byte2 & 170) | (option[1] & 85),
    (byte2 & 85) | (option[1] & 170),
  ];
}

function generateRandomStrBytes() {
  const randomValues = [0.123456789, 0.987654321, 0.555555555];
  const options = [[3, 45], [1, 0], [1, 5]];
  const arr = [];
  for (let k = 0; k < 3; k++) {
    arr.push.apply(arr, generRandom(Math.floor(randomValues[k] * 10000), options[k]));
  }
  return arr; // 12 bytes，与参考实现一致（固定）
}

// 自定义 48 位拆分：对可能 >2^32 的数用 Math.floor 分段取低字节，避免 JS 32 位移位截断
function splitToBytes(num) {
  return [
    Math.floor(num / 2 ** 24) & 255,
    Math.floor(num / 2 ** 16) & 255,
    Math.floor(num / 2 ** 8) & 255,
    num & 255,
  ];
}

function strBytes(s, enc = 'utf8') { return [...Buffer.from(s, enc)]; }

function generateRc4BbStr(urlSearchParams, userAgent, windowEnvStr, suffix, argsList) {
  suffix = suffix || 'cus';
  const args = argsList || [0, 1, 14];
  const sm3 = new SM3();
  const startTime = Date.now();
  // 1: url_search_params 两次 SM3
  const urlSearchParamsList = sm3.sum(sm3.sum(strBytes(urlSearchParams + suffix)));
  // 2: 对后缀两次 SM3
  const cus = sm3.sum(sm3.sum(strBytes(suffix)));
  // 3: 对 UA 处理
  const uaKey = [0, 1, 14];
  const ua = sm3.sum(resultEncrypt(rc4(strBytes(userAgent), uaKey), 's3').split('').map(c => c.charCodeAt(0)));
  const endTime = startTime + 100;

  const b = {};
  b[8] = 3;
  b[10] = endTime;
  b[15] = { aid: 6383, pageId: 110624 };
  b[16] = startTime;
  b[18] = 44;
  b[19] = [1, 0, 1, 5];

  const startBytes = splitToBytes(b[16]);
  b[20] = startBytes[0]; b[21] = startBytes[1]; b[22] = startBytes[2]; b[23] = startBytes[3];
  b[24] = Math.floor(b[16] / 2 ** 32) & 255;
  b[25] = Math.floor(b[16] / 2 ** 40) & 255;

  const arg0Bytes = splitToBytes(args[0]);
  b[26] = arg0Bytes[0]; b[27] = arg0Bytes[1]; b[28] = arg0Bytes[2]; b[29] = arg0Bytes[3];
  b[30] = Math.floor(args[1] / 256) & 255;
  b[31] = args[1] & 255;
  const arg1Bytes = splitToBytes(args[1]);
  b[32] = arg1Bytes[0]; b[33] = arg1Bytes[1];
  const arg2Bytes = splitToBytes(args[2]);
  b[34] = arg2Bytes[0]; b[35] = arg2Bytes[1]; b[36] = arg2Bytes[2]; b[37] = arg2Bytes[3];

  b[38] = urlSearchParamsList[21]; b[39] = urlSearchParamsList[22];
  b[40] = cus[21]; b[41] = cus[22];
  b[42] = ua[23]; b[43] = ua[24];

  const endBytes = splitToBytes(b[10]);
  b[44] = endBytes[0]; b[45] = endBytes[1]; b[46] = endBytes[2]; b[47] = endBytes[3];
  b[48] = b[8];
  b[49] = Math.floor(b[10] / 2 ** 32) & 255;
  b[50] = Math.floor(b[10] / 2 ** 40) & 255;

  b[51] = b[15].pageId;
  const pageIdBytes = splitToBytes(b[15].pageId);
  b[52] = pageIdBytes[0]; b[53] = pageIdBytes[1]; b[54] = pageIdBytes[2]; b[55] = pageIdBytes[3];
  b[56] = b[15].aid;
  b[57] = b[15].aid & 255;
  b[58] = Math.floor(b[15].aid / 256) & 255;
  b[59] = Math.floor(b[15].aid / 65536) & 255;
  b[60] = Math.floor(b[15].aid / 16777216) & 255;

  const windowEnvList = strBytes(windowEnvStr, 'ascii');
  b[64] = windowEnvList.length;
  b[65] = b[64] & 255;
  b[66] = Math.floor(b[64] / 256) & 255;
  b[69] = 0; b[70] = 0; b[71] = 0;

  b[72] = b[18] ^ b[20] ^ b[26] ^ b[30] ^ b[38] ^ b[40] ^ b[42] ^ b[21] ^ b[27] ^ b[31] ^
    b[35] ^ b[39] ^ b[41] ^ b[43] ^ b[22] ^ b[28] ^ b[32] ^ b[36] ^ b[23] ^ b[29] ^
    b[33] ^ b[37] ^ b[44] ^ b[45] ^ b[46] ^ b[47] ^ b[48] ^ b[49] ^ b[50] ^ b[24] ^
    b[25] ^ b[52] ^ b[53] ^ b[54] ^ b[55] ^ b[57] ^ b[58] ^ b[59] ^ b[60] ^ b[65] ^
    b[66] ^ b[70] ^ b[71];

  const bb = [
    b[18], b[20], b[52], b[26], b[30], b[34], b[58], b[38], b[40], b[53], b[42], b[21],
    b[27], b[54], b[55], b[31], b[35], b[57], b[39], b[41], b[43], b[22], b[28], b[32],
    b[60], b[36], b[23], b[29], b[33], b[37], b[44], b[45], b[59], b[46], b[47], b[48],
    b[49], b[50], b[24], b[25], b[65], b[66], b[70], b[71],
  ];
  bb.push(...windowEnvList);
  bb.push(b[72]);
  return rc4(bb, [121]);
}

const WINDOW_ENV = '1920|1080|1920|1040|0|30|0|0|1872|92|1920|1040|1857|92|1|24|Win32';

/** 计算抖音 a_bogus 签名。urlSearchParams: 不含 a_bogus 的 query 字符串 */
export function abSign(urlSearchParams, userAgent) {
  const rand = generateRandomStrBytes();
  const bb = generateRc4BbStr(urlSearchParams, userAgent, WINDOW_ENV);
  const payload = rand.concat(bb);
  return resultEncrypt(payload, 's4') + '=';
}
// 공용 암호화 모듈 — 브라우저(WebCrypto)와 Node(v20+) 양쪽에서 동작.
// PBKDF2(SHA-256, 30만회) → AES-256-GCM. 외부 의존성 없음.
'use strict';

const FT_ENC = new TextEncoder();
const FT_DEC = new TextDecoder();

function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64decode(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

const FT_ITER = 300000;  // 새로 봉인할 때의 PBKDF2 반복 횟수

async function ftDeriveKey(password, salt, iterations) {
  const km = await crypto.subtle.importKey(
    'raw', FT_ENC.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// 객체를 암호화해 {salt, iv, iter, data} (base64) 로 반환
async function sealJSON(obj, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await ftDeriveKey(password, salt, FT_ITER);
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, FT_ENC.encode(JSON.stringify(obj)));
  return { salt: b64encode(salt), iv: b64encode(iv), iter: FT_ITER, data: b64encode(data) };
}

// sealJSON 결과를 복호화. 암호가 틀리면 예외 발생.
// 반복 횟수는 파일에 기록된 값을 쓰므로 나중에 FT_ITER를 올려도 옛 파일이 열린다.
async function openJSON(blob, password) {
  const key = await ftDeriveKey(password, b64decode(blob.salt), blob.iter || 300000);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(blob.iv) }, key, b64decode(blob.data));
  return JSON.parse(FT_DEC.decode(plain));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sealJSON, openJSON };
}

// 공개될 수 있는 글(전달함 편지 · 결정 게시판)에서 이 PC의 경로를 가린다.
import os from 'node:os';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 같은 경로를 '\' · '/' 두 모양으로 모두 찾는다.
function pathVariants(p) {
  if (!p) return [];
  const a = String(p).replace(/[\\/]+$/, '');
  if (a.length < 3) return [];
  return [...new Set([a, a.replace(/\\/g, '/'), a.replace(/\//g, '\\')])];
}

// 홈이 너무 짧거나 한 단계(`/app` 등)면 바꾸지 않는다(`src/app/x` 같은 평범한 글이 망가지지 않게).
function usableHome(home) {
  const h = String(home || '').replace(/[\\/]+$/, '');
  if (h.length < 8) return false;
  const segs = h.replace(/^[A-Za-z]:/, '').split(/[\\/]/).filter(Boolean);
  return segs.length >= 2;
}

export function redact(text, { paths = [], home = os.homedir(), tmp = os.tmpdir() } = {}) {
  let s = String(text ?? '');
  const named = [
    ...paths.filter(Boolean).map((p) => [p, '<경로>']),
    ...(usableHome(tmp) ? [[tmp, '<임시>']] : []),
    ...(usableHome(home) ? [[home, '<홈>']] : []),
  ];
  // 긴 경로부터 바꿔야 홈 아래 실행 폴더가 <홈>/… 로 새지 않는다.
  named.sort((x, y) => String(y[0]).length - String(x[0]).length);
  for (const [p, label] of named) {
    for (const v of pathVariants(p)) s = s.replace(new RegExp(esc(v), 'gi'), label);
  }
  s = s.replace(/file:\/\/\/?[^\s'"<>)]+/gi, '<파일>');
  // 드라이브 경로는 줄 처음 · 공백 · 따옴표 · 괄호 · = 뒤에서만(`a:/b` 같은 정규식 · 비율 글을 건드리지 않게).
  // 그리고 폴더가 두 단계 이상일 때만(`a:/b` 한 단계는 경로로 보지 않는다).
  s = s.replace(/(^|[\s'"(=])[A-Za-z]:[\\/][^\s'"<>|\\/]+[\\/][^\s'"<>|]*/gm, '$1<경로>');
  s = s.replace(/(^|[\s'"(=])\/(?:home|Users|root)\/[^\s'"<>)]*/g, '$1<홈>');
  return s;
}

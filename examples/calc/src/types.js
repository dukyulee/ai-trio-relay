// 계약 파일(trio 계약): 모든 조각이 이 모양을 따른다. 조각은 이 파일을 고치지 않는다.

/** 표시할 소수점 자리 수 */
export const PRECISION = 2;

/** @typedef {(a: number, b: number) => number} BinaryOp */

// 입력 검사: 유한한 숫자가 아니면 TypeError.
export function assertNumber(x, name) {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new TypeError(`${name}는 유한한 숫자여야 한다`);
  }
}

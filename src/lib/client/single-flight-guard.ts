export function createSingleFlightGuard() {
  let occupied = false;
  return {
    enter() {
      if (occupied) return false;
      occupied = true;
      return true;
    },
    release() { occupied = false; },
  };
}

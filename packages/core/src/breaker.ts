/**
 * 회로 차단기 (설계 §4-4 개선 ①, 이슈 #1).
 *
 * 공공 API가 장애일 때 요청마다 제한 시간·재시도를 다 기다리면 Lambda가 그만큼 오래 붙잡혀
 * 동시 실행과 비용이 늘어난다(건축HUB 장애 모의: 처리 7.5초, 동시 실행 11 → 97).
 * 일시 오류가 연달아 나면 잠시 호출하지 않고 바로 실패로 돌려준다.
 *
 * 상태: 닫힘(정상 호출) → 연속 실패 failureThreshold번 → 열림(openMs 동안 즉시 실패)
 *       → 시간이 지나면 반열림(시험 호출 하나만 허용) → 성공하면 닫힘, 실패하면 다시 열림.
 * 상태는 프로세스 메모리에 있다. Lambda 인스턴스마다 따로 열리지만 각자 몇 번만 실패하면 열리므로 충분하다.
 */
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** 연속 실패 몇 번에 열지. 기본 5 */
  failureThreshold?: number;
  /** 열려 있는 시간. 기본 30초 */
  openMs?: number;
  /** 테스트용 시계 */
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: BreakerState = 'closed';
  private trialInFlight = false;
  readonly failureThreshold: number;
  readonly openMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.openMs = opts.openMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  /** 지금 호출해도 되는지. false면 호출하지 말고 바로 실패로 처리한다 */
  allow(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.openMs) return false;
      this.state = 'half_open';
    }
    // 반열림: 시험 호출은 한 번에 하나만
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  success(): void {
    this.failures = 0;
    this.state = 'closed';
    this.trialInFlight = false;
  }

  /** 일시 오류(장애로 볼 만한 실패)만 센다. 0건·키 오류 같은 건 success()도 failure()도 부르지 않는다 */
  failure(): void {
    this.trialInFlight = false;
    if (this.state === 'half_open') {
      this.trip();
      return;
    }
    this.failures++;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  /** 결과가 성공·실패 어느 쪽도 아닐 때(설정 오류 등) 반열림 시험 자리를 돌려준다 */
  release(): void {
    this.trialInFlight = false;
  }

  /** 열림 상태면 남은 시간(ms), 아니면 0 */
  remainingMs(): number {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.openMs - (this.now() - this.openedAt));
  }

  get current(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.openMs) return 'half_open';
    return this.state;
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.failures = 0;
  }
}

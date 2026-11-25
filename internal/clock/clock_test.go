package clock

import (
	"sync"
	"testing"
	"time"
)

func TestFakeClock_AdvanceChronologicalAndTies(t *testing.T) {
	base := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	clk := NewFake(base)

	var order []string
	var firedAt []time.Time

	clk.AfterFunc(10*time.Minute, func() {
		order = append(order, "10m-a")
		firedAt = append(firedAt, clk.Now())
	})
	clk.AfterFunc(5*time.Minute, func() {
		order = append(order, "5m")
		firedAt = append(firedAt, clk.Now())
	})
	clk.AfterFunc(10*time.Minute, func() {
		order = append(order, "10m-b")
		firedAt = append(firedAt, clk.Now())
	})
	clk.AfterFunc(20*time.Minute, func() {
		order = append(order, "20m")
		firedAt = append(firedAt, clk.Now())
	})

	if clk.PendingCount() != 4 {
		t.Fatalf("expected 4 pending timers, got %d", clk.PendingCount())
	}

	clk.Advance(15 * time.Minute)

	want := []string{"5m", "10m-a", "10m-b"}
	if len(order) != len(want) {
		t.Fatalf("fired order = %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order[%d] = %q, want %q", i, order[i], want[i])
		}
	}
	if !firedAt[0].Equal(base.Add(5 * time.Minute)) {
		t.Fatalf("first timer saw %v, want +5m", firedAt[0])
	}
	if !firedAt[1].Equal(base.Add(10 * time.Minute)) {
		t.Fatalf("second timer saw %v, want +10m", firedAt[1])
	}
	if !clk.Now().Equal(base.Add(15 * time.Minute)) {
		t.Fatalf("clock now = %v, want +15m", clk.Now())
	}
	if clk.PendingCount() != 1 {
		t.Fatalf("expected 1 remaining timer, got %d", clk.PendingCount())
	}
}

func TestFakeClock_StopCancelsTimerAndIsIdempotent(t *testing.T) {
	base := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	clk := NewFake(base)

	fired := false
	stop := clk.AfterFunc(5*time.Minute, func() { fired = true })

	if !stop() {
		t.Fatalf("first stop should return true")
	}
	if stop() {
		t.Fatalf("second stop should return false")
	}
	if clk.PendingCount() != 0 {
		t.Fatalf("expected 0 pending timers after stop, got %d", clk.PendingCount())
	}

	clk.Advance(10 * time.Minute)
	if fired {
		t.Fatalf("stopped timer should not fire")
	}
}

func TestFakeClock_CallbackCanScheduleAndCancelTimers(t *testing.T) {
	base := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	clk := NewFake(base)

	var events []string
	var stopSecond StopFunc

	clk.AfterFunc(5*time.Minute, func() {
		events = append(events, "first")
		stopSecond()
		clk.AfterFunc(3*time.Minute, func() {
			events = append(events, "chained")
		})
	})
	stopSecond = clk.AfterFunc(10*time.Minute, func() {
		events = append(events, "cancelled")
	})

	clk.Advance(15 * time.Minute)

	want := []string{"first", "chained"}
	if len(events) != len(want) || events[0] != want[0] || events[1] != want[1] {
		t.Fatalf("events = %v, want %v", events, want)
	}
}

func TestFakeClock_SetDoesNotFireTimersUntilFireDue(t *testing.T) {
	base := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	clk := NewFake(base)

	fired := false
	clk.AfterFunc(5*time.Minute, func() { fired = true })

	// Simulate laptop sleep: wall clock jumps forward without firing OS timer.
	clk.Set(base.Add(2 * time.Hour))
	if fired {
		t.Fatalf("Set must not fire timers")
	}
	if clk.PendingCount() != 1 {
		t.Fatalf("timer should remain pending after Set")
	}

	// Simulate backward clock jump.
	clk.Set(base.Add(-1 * time.Hour))
	if !clk.Now().Equal(base.Add(-1 * time.Hour)) {
		t.Fatalf("expected backward Set to take effect")
	}

	// Jump past deadline and explicitly fire due timers.
	clk.Set(base.Add(10 * time.Minute))
	clk.FireDue()
	if !fired {
		t.Fatalf("FireDue should fire overdue timers")
	}
}

func TestFakeClock_ZeroAndNegativeDelayNotSynchronous(t *testing.T) {
	base := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	clk := NewFake(base)

	fired := false
	clk.AfterFunc(-time.Second, func() { fired = true })
	if fired {
		t.Fatalf("AfterFunc must not fire synchronously")
	}
	clk.Advance(0)
	if !fired {
		t.Fatalf("Advance(0) should fire zero-delay timer")
	}
}

func TestFakeClock_ConcurrentAccess(t *testing.T) {
	base := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	clk := NewFake(base)

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			stop := clk.AfterFunc(time.Duration(i+1)*time.Millisecond, func() {
				_ = clk.Now()
			})
			if i%2 == 0 {
				stop()
			}
			_ = clk.Now()
		}(i)
	}
	wg.Wait()
	clk.Advance(time.Second)
	if clk.PendingCount() != 0 {
		t.Fatalf("expected all timers drained, got %d", clk.PendingCount())
	}
}

func TestRealClock_Basic(t *testing.T) {
	clk := NewReal()
	before := time.Now()
	got := clk.Now()
	after := time.Now()
	if got.Before(before) || got.After(after) {
		t.Fatalf("RealClock.Now() = %v outside [%v, %v]", got, before, after)
	}

	done := make(chan struct{})
	stop := clk.AfterFunc(5*time.Millisecond, func() { close(done) })
	defer stop()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("RealClock.AfterFunc did not fire")
	}

	// Stopping a cancelled timer returns false on second call.
	stop2 := clk.AfterFunc(time.Hour, func() {})
	if !stop2() {
		t.Fatalf("expected active RealClock timer stop to return true")
	}
	if stop2() {
		t.Fatalf("expected already-stopped RealClock timer stop to return false")
	}

	// Nil callback should be a safe no-op.
	if clk.AfterFunc(time.Millisecond, nil)() {
		t.Fatalf("nil callback StopFunc should return false")
	}
}

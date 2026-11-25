package clock

import (
	"sort"
	"sync"
	"time"
)

// StopFunc cancels a scheduled timer. It returns true if the timer was active
// and successfully cancelled before firing, or false if it had already fired or
// been stopped.
type StopFunc func() bool

// Clock abstracts wall-clock time and timers so domain packages never call
// time.Now or time.AfterFunc directly.
type Clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, fn func()) StopFunc
}

// RealClock delegates to the standard library wall clock and timers.
type RealClock struct{}

// NewReal returns a Clock backed by the real system clock.
func NewReal() *RealClock {
	return &RealClock{}
}

// Now returns the current local system time.
func (RealClock) Now() time.Time {
	return time.Now()
}

// AfterFunc schedules fn to run in its own goroutine after duration d.
func (RealClock) AfterFunc(d time.Duration, fn func()) StopFunc {
	if fn == nil {
		return func() bool { return false }
	}
	t := time.AfterFunc(d, fn)
	return t.Stop
}

type fakeTimer struct {
	id       uint64
	deadline time.Time
	fn       func()
	stopped  bool
	fired    bool
}

// FakeClock is a deterministic, goroutine-safe Clock for unit tests.
type FakeClock struct {
	mu     sync.Mutex
	now    time.Time
	nextID uint64
	timers []*fakeTimer
}

// NewFake creates a FakeClock initialized to initial.
func NewFake(initial time.Time) *FakeClock {
	return &FakeClock{now: initial}
}

// Now returns the fake clock's current time.
func (c *FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// AfterFunc registers a timer that fires when the fake clock advances to or
// past Now()+d. It never invokes fn synchronously during registration, matching
// real timer lock-safety semantics.
func (c *FakeClock) AfterFunc(d time.Duration, fn func()) StopFunc {
	if fn == nil {
		return func() bool { return false }
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	if d < 0 {
		d = 0
	}
	c.nextID++
	tm := &fakeTimer{
		id:       c.nextID,
		deadline: c.now.Add(d),
		fn:       fn,
	}
	c.timers = append(c.timers, tm)

	return func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		if tm.stopped || tm.fired {
			return false
		}
		tm.stopped = true
		c.removeTimerLocked(tm.id)
		return true
	}
}

// Advance moves the clock forward by d (d >= 0) and fires every active timer
// whose deadline is at or before the target time, in chronological order.
// Timers scheduled by callbacks with deadlines <= target also fire.
func (c *FakeClock) Advance(d time.Duration) {
	if d < 0 {
		panic("clock.FakeClock.Advance: negative duration; use Set to move backwards")
	}
	c.mu.Lock()
	target := c.now.Add(d)
	c.mu.Unlock()

	c.fireUntil(target, true)
}

// Set jumps the clock directly to t (forward or backward) WITHOUT firing
// pending timers. Use this to simulate laptop sleep (forward jump where OS
// timers did not fire) or NTP / wall-clock rollback (backward jump).
func (c *FakeClock) Set(t time.Time) {
	c.mu.Lock()
	c.now = t
	c.mu.Unlock()
}

// FireDue fires any active timers whose deadline is at or before the current
// fake time, in chronological order, without advancing the clock further.
func (c *FakeClock) FireDue() {
	c.mu.Lock()
	target := c.now
	c.mu.Unlock()

	c.fireUntil(target, false)
}

// PendingCount returns the number of active timers that have not fired or been
// stopped.
func (c *FakeClock) PendingCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.timers)
}

func (c *FakeClock) fireUntil(target time.Time, setTargetAtEnd bool) {
	for {
		c.mu.Lock()
		next := c.popNextDueLocked(target)
		if next == nil {
			if setTargetAtEnd && target.After(c.now) {
				c.now = target
			}
			c.mu.Unlock()
			return
		}
		if next.deadline.After(c.now) {
			c.now = next.deadline
		}
		next.fired = true
		fn := next.fn
		c.mu.Unlock()

		// Execute callback outside mutex so it may call Now, AfterFunc, or Stop.
		fn()
	}
}

func (c *FakeClock) popNextDueLocked(target time.Time) *fakeTimer {
	if len(c.timers) == 0 {
		return nil
	}
	sort.Slice(c.timers, func(i, j int) bool {
		a, b := c.timers[i], c.timers[j]
		if a.deadline.Equal(b.deadline) {
			return a.id < b.id
		}
		return a.deadline.Before(b.deadline)
	})
	first := c.timers[0]
	if first.deadline.After(target) {
		return nil
	}
	c.timers = c.timers[1:]
	return first
}

func (c *FakeClock) removeTimerLocked(id uint64) {
	for i, tm := range c.timers {
		if tm.id == id {
			c.timers = append(c.timers[:i], c.timers[i+1:]...)
			return
		}
	}
}

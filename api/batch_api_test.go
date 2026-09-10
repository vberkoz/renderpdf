package main

import (
	"testing"
	"time"
)

func TestBatchJobItemInitializesAtomicTransitionCounters(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	job := batchJobReply{JobID: "job_123", ItemCount: 3, QueuedCount: 3, CreatedAt: now, UpdatedAt: now}
	item := batchJobItem("account_123", job, `{"version":"1"}`)
	for field, want := range map[string]int{"itemCount": 3, "queuedCount": 3, "runningCount": 0, "succeededCount": 0, "failedCount": 0, "cancelledCount": 0} {
		if got := batchNumber(item, field, -1); got != want {
			t.Fatalf("%s = %d, want %d", field, got, want)
		}
	}
	if got := len(item); got == 0 || item["status"] == nil || *item["status"].S != "queued" {
		t.Fatalf("job item is not initialized as queued: %#v", item["status"])
	}
}

func TestDerivedBatchStatus(t *testing.T) {
	cases := []struct {
		name string
		job  batchJobReply
		want string
	}{
		{"queued", batchJobReply{ItemCount: 2, QueuedCount: 2}, "queued"},
		{"running", batchJobReply{ItemCount: 2, QueuedCount: 1, RunningCount: 1}, "running"},
		{"completed with failures", batchJobReply{ItemCount: 2, SucceededCount: 1, FailedCount: 1}, "completed"},
		{"retry exhaustion is terminal", batchJobReply{ItemCount: 1, FailedCount: 1}, "completed"},
		{"cancelling", batchJobReply{ItemCount: 2, RunningCount: 1, CancelRequested: true}, "cancelling"},
		{"cancelled", batchJobReply{ItemCount: 2, CancelledCount: 2, CancelRequested: true}, "cancelled"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := derivedBatchStatus(tc.job); got != tc.want {
				t.Fatalf("status = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBatchJobsAreSortedNewestFirst(t *testing.T) {
	jobs := []batchJobReply{
		{JobID: "job_old", CreatedAt: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)},
		{JobID: "job_new", CreatedAt: time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)},
	}
	sortBatchJobsNewestFirst(jobs)
	if got := jobs[0].JobID; got != "job_new" {
		t.Fatalf("first job = %q, want newest job_new", got)
	}
}

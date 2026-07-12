package replay

import "testing"

func TestBufferUsesMonotonicSequencesAndReplayCursor(t *testing.T) {
	buffer := New(10, 1024)
	first := buffer.Add("stdout", "one")
	second := buffer.Add("stderr", "two")
	third := buffer.Add("stdout", "three")
	if first.Sequence != 0 || second.Sequence != 1 || third.Sequence != 2 {
		t.Fatalf("sequences = %d, %d, %d", first.Sequence, second.Sequence, third.Sequence)
	}
	replayed := buffer.After(0)
	if len(replayed) != 2 || replayed[0].Sequence != 1 || replayed[1].Sequence != 2 {
		t.Fatalf("After(0) = %#v", replayed)
	}
}

func TestBufferEvictsOldestChunksByCount(t *testing.T) {
	buffer := New(2, 1024)
	buffer.Add("stdout", "one")
	buffer.Add("stdout", "two")
	buffer.Add("stdout", "three")
	chunks := buffer.After(-1)
	if len(chunks) != 2 || chunks[0].Sequence != 1 || chunks[1].Sequence != 2 {
		t.Fatalf("retained chunks = %#v", chunks)
	}
}

func TestBufferEvictsOldestChunksByBytes(t *testing.T) {
	buffer := New(10, 6)
	buffer.Add("stdout", "1234")
	buffer.Add("stdout", "5678")
	chunks, bytes := buffer.Size()
	if chunks != 1 || bytes != 4 {
		t.Fatalf("Size() = (%d, %d), want (1, 4)", chunks, bytes)
	}
	if buffer.NextSequence() != 2 {
		t.Fatalf("NextSequence() = %d, want 2", buffer.NextSequence())
	}
}

func TestBufferTruncatesSingleChunkToHardByteLimit(t *testing.T) {
	buffer := New(10, 4)
	chunk := buffer.Add("stdout", "123456")
	if chunk.Data != "1234" {
		t.Fatalf("chunk data = %q, want %q", chunk.Data, "1234")
	}
	_, bytes := buffer.Size()
	if bytes != 4 {
		t.Fatalf("buffer bytes = %d, want 4", bytes)
	}
}

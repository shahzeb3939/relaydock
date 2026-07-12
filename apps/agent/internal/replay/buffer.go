package replay

import (
	"sync"
	"unicode/utf8"

	"github.com/relaydock/relaydock/apps/agent/internal/protocol"
)

const (
	DefaultMaxChunks = protocol.MaxOutputChunksPerSync
	DefaultMaxBytes  = 4 * 1024 * 1024
)

type Buffer struct {
	mu        sync.RWMutex
	chunks    []protocol.OutputChunk
	bytes     int
	next      int64
	maxChunks int
	maxBytes  int
}

func New(maxChunks, maxBytes int) *Buffer {
	if maxChunks <= 0 {
		maxChunks = DefaultMaxChunks
	}
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	return &Buffer{maxChunks: maxChunks, maxBytes: maxBytes}
}

func (b *Buffer) Add(stream, data string) protocol.OutputChunk {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(data) > b.maxBytes {
		limit := b.maxBytes
		for limit > 0 && !utf8.ValidString(data[:limit]) {
			limit--
		}
		data = data[:limit]
	}
	chunk := protocol.OutputChunk{Sequence: b.next, Stream: stream, Data: data}
	b.next++
	b.chunks = append(b.chunks, chunk)
	b.bytes += len(data)
	for len(b.chunks) > b.maxChunks || (b.bytes > b.maxBytes && len(b.chunks) > 1) {
		b.bytes -= len(b.chunks[0].Data)
		copy(b.chunks, b.chunks[1:])
		b.chunks = b.chunks[:len(b.chunks)-1]
	}
	return chunk
}

func (b *Buffer) After(sequence int64) []protocol.OutputChunk {
	b.mu.RLock()
	defer b.mu.RUnlock()
	start := len(b.chunks)
	for index := range b.chunks {
		if b.chunks[index].Sequence > sequence {
			start = index
			break
		}
	}
	result := make([]protocol.OutputChunk, len(b.chunks)-start)
	copy(result, b.chunks[start:])
	return result
}

func (b *Buffer) NextSequence() int64 {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.next
}

func (b *Buffer) Size() (chunks, bytes int) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.chunks), b.bytes
}

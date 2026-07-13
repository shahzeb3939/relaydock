//go:build !darwin && !linux && !windows

package installer

func effectiveUID() int {
	return -1
}

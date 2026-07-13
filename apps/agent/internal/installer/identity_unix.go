//go:build darwin || linux

package installer

import "os"

func effectiveUID() int {
	return os.Geteuid()
}

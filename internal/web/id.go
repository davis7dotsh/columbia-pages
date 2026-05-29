package web

import "crypto/rand"

const idAlphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
const idLen = 12 // 62^12 ≈ 71 bits — unguessable

// newID returns a URL-safe, unguessable base62 identifier. It uses rejection
// sampling so every character is uniformly distributed (no modulo bias).
func newID() (string, error) {
	out := make([]byte, idLen)
	buf := make([]byte, 1)
	for i := 0; i < idLen; {
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		// 62*4 = 248; reject the top 8 values to keep the distribution uniform.
		if buf[0] >= 248 {
			continue
		}
		out[i] = idAlphabet[buf[0]%62]
		i++
	}
	return string(out), nil
}

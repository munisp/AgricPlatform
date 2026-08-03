package gateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ComputeSignature returns the HMAC-SHA256 of body under secret, encoded per
// the provider's configured encoding ("hex" or "base64"). Exported for tests
// and tooling; the hot path uses VerifySignature.
func ComputeSignature(secret string, body []byte, encoding string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	sum := mac.Sum(nil)
	if encoding == "base64" {
		return base64.StdEncoding.EncodeToString(sum)
	}
	return hex.EncodeToString(sum)
}

// VerifySignature checks headerValue against the HMAC-SHA256 of the raw body
// using a constant-time comparison. For hex encoding an optional "sha256="
// prefix (GitHub convention) is tolerated. For base64 both padded and raw
// standard encodings are accepted.
func VerifySignature(secret string, body []byte, headerValue, encoding string) bool {
	headerValue = strings.TrimSpace(headerValue)
	if headerValue == "" {
		return false
	}
	var provided []byte
	var err error
	switch encoding {
	case "base64":
		provided, err = base64.StdEncoding.DecodeString(headerValue)
		if err != nil {
			provided, err = base64.RawStdEncoding.DecodeString(headerValue)
		}
		if err != nil {
			return false
		}
	default: // hex
		v := strings.TrimPrefix(strings.ToLower(headerValue), "sha256=")
		provided, err = hex.DecodeString(v)
		if err != nil {
			return false
		}
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(provided, mac.Sum(nil))
}

// ParseTimestamp accepts a Unix-seconds timestamp or an RFC3339 timestamp.
func ParseTimestamp(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, errors.New("missing timestamp")
	}
	if secs, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return time.Unix(secs, 0).UTC(), nil
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("unparseable timestamp %q (want Unix seconds or RFC3339)", raw)
}

// CheckTimestamp enforces the ±maxSkew window around now. A timestamp exactly
// maxSkew away is still accepted; anything beyond is rejected.
func CheckTimestamp(raw string, now time.Time, maxSkew time.Duration) error {
	ts, err := ParseTimestamp(raw)
	if err != nil {
		return err
	}
	delta := now.Sub(ts)
	if delta < 0 {
		delta = -delta
	}
	if delta > maxSkew {
		return fmt.Errorf("timestamp outside ±%ds skew window (delta %ds)", int64(maxSkew.Seconds()), int64(delta.Seconds()))
	}
	return nil
}

package gateway

import (
	"strconv"
	"testing"
	"time"
)

const (
	testSecret = "test-secret"
	testBody   = `{"event":"soil-moisture","value":42}`
	// Known-answer vectors, generated with an independent implementation:
	//   python3 -c 'import hmac,hashlib; print(hmac.new(b"test-secret", b"{\"event\":\"soil-moisture\",\"value\":42}", hashlib.sha256).hexdigest())'
	wantHex = "bd168eb9aa3482bf49e4275ddca61aaf4c3303d9de57b7cf9019f2a218c28551"
	wantB64 = "vRaOuao0gr9J5Cdd3KYar0wzA9neV7fPkBnyohjChVE="
)

func TestVerifySignatureKnownAnswer(t *testing.T) {
	cases := []struct {
		name     string
		secret   string
		body     string
		header   string
		encoding string
		want     bool
	}{
		{"hex known-answer", testSecret, testBody, wantHex, "hex", true},
		{"hex with sha256= prefix", testSecret, testBody, "sha256=" + wantHex, "hex", true},
		{"base64 known-answer", testSecret, testBody, wantB64, "base64", true},
		{"wrong signature", testSecret, testBody, "e1613d6bafa08425c664e25191731c5ac2eb5a8956e252cab6badea46bd73e1b", "hex", false},
		{"wrong secret", "other-secret", testBody, wantHex, "hex", false},
		{"tampered body", testSecret, `{"event":"soil-moisture","value":43}`, wantHex, "hex", false},
		{"malformed hex", testSecret, testBody, "zzzz-not-hex", "hex", false},
		{"malformed base64", testSecret, testBody, "!!!not-base64!!!", "base64", false},
		{"empty header", testSecret, testBody, "", "hex", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := VerifySignature(tc.secret, []byte(tc.body), tc.header, tc.encoding); got != tc.want {
				t.Fatalf("VerifySignature() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCheckTimestampSkewBoundaries(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	skew := 300 * time.Second
	cases := []struct {
		name      string
		deltaSecs int64 // timestamp = now - deltaSecs (negative = future)
		wantOK    bool
	}{
		{"301s in the past: reject", 301, false},
		{"300s in the past: accept (boundary)", 300, true},
		{"299s in the past: accept", 299, true},
		{"now: accept", 0, true},
		{"299s in the future: accept", -299, true},
		{"300s in the future: accept (boundary)", -300, true},
		{"301s in the future: reject", -301, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts := strconv.FormatInt(now.Add(-time.Duration(tc.deltaSecs)*time.Second).Unix(), 10)
			err := CheckTimestamp(ts, now, skew)
			if tc.wantOK && err != nil {
				t.Fatalf("CheckTimestamp(%s) = %v, want accept", ts, err)
			}
			if !tc.wantOK && err == nil {
				t.Fatalf("CheckTimestamp(%s) = nil, want reject", ts)
			}
		})
	}
}

func TestParseTimestampFormats(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{"unix seconds", "1700000000", false},
		{"rfc3339", "2023-11-14T22:13:20Z", false},
		{"empty", "", true},
		{"garbage", "yesterday-ish", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseTimestamp(tc.raw)
			if tc.wantErr != (err != nil) {
				t.Fatalf("ParseTimestamp(%q) err = %v, wantErr %v", tc.raw, err, tc.wantErr)
			}
		})
	}
}

func TestComputeSignatureMatchesVectors(t *testing.T) {
	if got := ComputeSignature(testSecret, []byte(testBody), "hex"); got != wantHex {
		t.Fatalf("ComputeSignature hex = %s, want %s", got, wantHex)
	}
	if got := ComputeSignature(testSecret, []byte(testBody), "base64"); got != wantB64 {
		t.Fatalf("ComputeSignature base64 = %s, want %s", got, wantB64)
	}
}

package panel

import "testing"

// 与面板（Node.js）计算的签名一致（向量由 node:crypto 生成，见 server/test 中的同一组数据）
func TestSigningVectors(t *testing.T) {
	bh := SHA256Hex([]byte(`{"cpu":1}`))
	if bh != "d6c34d94bce46312e061d19dbab47c7acfe6d2d6ece35fb884e7717a29fa0f83" {
		t.Fatalf("body hash %s", bh)
	}
	sig := HMACHex("s3cret", SigningPayload("post", "/api/agent/nodes/report", "1700000000000", "nonce_abcdefghijklmnop", bh))
	if sig != "0fbd72b08c7997c19347577d8838b13071407e2b25016689e8c78b28d9c7309b" {
		t.Fatalf("signature %s", sig)
	}
	if !VerifyResponse("s3cret", "nonce_abcdefghijklmnop", []byte(`{"ok":true}`), "db4f24a15cb510faa0675343d44a955bfb573fb0cf69153a7cb29769d0585a3c") {
		t.Fatal("response signature")
	}
	if VerifyResponse("s3cret", "other_nonce_abcdefgh", []byte(`{"ok":true}`), "db4f24a15cb510faa0675343d44a955bfb573fb0cf69153a7cb29769d0585a3c") {
		t.Fatal("response signature must bind the nonce")
	}
}

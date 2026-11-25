package verify

import (
	"context"
	"encoding/binary"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"amnezia-egressd/internal/types"
)

func startMockUDPAndTCPDNS(t *testing.T) (string, func()) {
	t.Helper()
	udpConn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := udpConn.LocalAddr().String()

	buildReply := func(req []byte) []byte {
		reply := make([]byte, len(req)+16)
		copy(reply, req)
		binary.BigEndian.PutUint16(reply[2:4], 0x8180)
		binary.BigEndian.PutUint16(reply[6:8], 1)
		off := len(req)
		binary.BigEndian.PutUint16(reply[off:off+2], 0xc00c)
		binary.BigEndian.PutUint16(reply[off+2:off+4], 1)
		binary.BigEndian.PutUint16(reply[off+4:off+6], 1)
		binary.BigEndian.PutUint32(reply[off+6:off+10], 60)
		binary.BigEndian.PutUint16(reply[off+10:off+12], 4)
		copy(reply[off+12:off+16], []byte{198, 51, 100, 1})
		return reply
	}

	go func() {
		buf := make([]byte, 512)
		for {
			n, raddr, rErr := udpConn.ReadFrom(buf)
			if rErr != nil {
				return
			}
			_, _ = udpConn.WriteTo(buildReply(buf[:n]), raddr)
		}
	}()

	return addr, func() { _ = udpConn.Close() }
}

func TestVerifyExitSuccessAndMismatch(t *testing.T) {
	dnsAddr, stopDNS := startMockUDPAndTCPDNS(t)
	defer stopDNS()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("127.0.0.1\n"))
	}))
	defer srv.Close()

	res := verifyExit(context.Background(), types.VerifyExitRequest{
		EgressIPv4: "127.0.0.1",
		ProbeURL:   srv.URL,
		DNSServer:  dnsAddr,
		TimeoutMs:  3000,
	}, false)
	if !res.OK || !res.IPMatch || !res.DNSOK || res.ObservedIP != "127.0.0.1" {
		t.Fatalf("expected OK response, got %+v", res)
	}

	mismatchSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("203.0.113.99"))
	}))
	defer mismatchSrv.Close()

	mismatch := verifyExit(context.Background(), types.VerifyExitRequest{
		EgressIPv4: "127.0.0.1",
		ProbeURL:   mismatchSrv.URL,
		DNSServer:  dnsAddr,
		TimeoutMs:  3000,
	}, false)
	if mismatch.OK || mismatch.IPMatch || mismatch.ObservedIP != "203.0.113.99" {
		t.Fatalf("expected IP mismatch failure, got %+v", mismatch)
	}
}

func TestVerifyExitRefusesLoopbackAndPrivateSSRF(t *testing.T) {
	dnsAddr, stopDNS := startMockUDPAndTCPDNS(t)
	defer stopDNS()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("127.0.0.1\n"))
	}))
	defer srv.Close()

	res := VerifyExit(context.Background(), types.VerifyExitRequest{
		EgressIPv4: "127.0.0.1",
		ProbeURL:   srv.URL,
		DNSServer:  dnsAddr,
		TimeoutMs:  3000,
	})
	if res.OK || !strings.Contains(res.HTTPError, "refused non-public") || !strings.Contains(res.DNSError, "refused non-public") {
		t.Fatalf("expected VerifyExit SSRF refusal for HTTP and DNS, got %+v", res)
	}
}

func TestRunHttpCheckRefusesLoopbackAndPrivateSSRF(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Test", "ok")
		_, _ = w.Write([]byte("hello-egress"))
	}))
	defer srv.Close()

	// Public-only exported handler refuses loopback target
	ssrfRes := RunHttpCheck(context.Background(), types.HttpCheckRequest{
		EgressIPv4: "127.0.0.1",
		URL:        srv.URL,
		TimeoutMs:  3000,
	})
	if !strings.Contains(ssrfRes.Error, "refused non-public") {
		t.Fatalf("expected SSRF refusal for 127.0.0.1, got %+v", ssrfRes)
	}

	// Internal helper (publicOnly=false) completes full response fetch & header capture
	res := runHttpCheck(context.Background(), types.HttpCheckRequest{
		EgressIPv4: "127.0.0.1",
		URL:        srv.URL,
		TimeoutMs:  3000,
	}, false)
	if res.Error != "" || res.Status != 200 || res.Body != "hello-egress" || res.Headers["x-test"] != "ok" {
		t.Fatalf("unexpected http check result: %+v", res)
	}
}

package verify

import (
	"context"
	"encoding/binary"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

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

func TestIsPublicUnicastRejectsSpecialUseIPv4Ranges(t *testing.T) {
	rejected := []string{
		"0.0.0.1",
		"10.0.0.1",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.169.254",
		"172.16.0.1",
		"192.0.0.1",
		"192.0.2.10",
		"192.168.1.1",
		"198.18.0.1",
		"198.19.255.254",
		"198.51.100.1",
		"203.0.113.10",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
		"::ffff:192.0.2.1",
		"::1",
		"fd00::1",
	}
	for _, raw := range rejected {
		addr := netip.MustParseAddr(raw)
		if IsPublicUnicast(addr) {
			t.Fatalf("expected IsPublicUnicast(%s) to be false", raw)
		}
	}
	for _, raw := range []string{"1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"} {
		addr := netip.MustParseAddr(raw)
		if !IsPublicUnicast(addr) {
			t.Fatalf("expected IsPublicUnicast(%s) to be true", raw)
		}
	}
}

func TestFwmarkPlumbingAppliedToHTTPAndDNSDials(t *testing.T) {
	orig := applySocketMark
	defer func() { applySocketMark = orig }()

	var (
		mu        sync.Mutex
		seenMarks []uint32
	)
	applySocketMark = func(_ syscall.RawConn, fwmark uint32) error {
		mu.Lock()
		seenMarks = append(seenMarks, fwmark)
		mu.Unlock()
		return nil
	}

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
		Fwmark:     0x0000ae01,
	}, false)
	if !res.OK {
		t.Fatalf("expected VerifyExit OK, got %+v", res)
	}
	if len(seenMarks) < 2 {
		t.Fatalf("expected applySocketMark on both HTTP and DNS dials, got %+v", seenMarks)
	}
	for _, m := range seenMarks {
		if m != 0x0000ae01 {
			t.Fatalf("expected fwmark 0x0000ae01, got 0x%x", m)
		}
	}
}

func TestVerifyExitRunsHTTPAndDNSConcurrently(t *testing.T) {
	dnsAddr, stopDNS := startMockUDPAndTCPDNS(t)
	defer stopDNS()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(150 * time.Millisecond)
		_, _ = w.Write([]byte("127.0.0.1\n"))
	}))
	defer srv.Close()

	start := time.Now()
	res := verifyExit(context.Background(), types.VerifyExitRequest{
		EgressIPv4: "127.0.0.1",
		ProbeURL:   srv.URL,
		DNSServer:  dnsAddr,
		TimeoutMs:  350,
	}, false)
	elapsed := time.Since(start)
	if !res.OK {
		t.Fatalf("expected concurrent verify OK, got %+v", res)
	}
	if elapsed > 340*time.Millisecond {
		t.Fatalf("expected concurrent HTTP+DNS under timeout (350ms), took %v", elapsed)
	}
}

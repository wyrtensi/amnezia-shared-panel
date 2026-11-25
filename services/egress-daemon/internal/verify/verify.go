package verify

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"

	"amnezia-egressd/internal/types"
)

const (
	defaultVerifyTimeout = 8 * time.Second
	defaultHttpTimeout   = 10 * time.Second
	maxHttpBodyBytes     = 64 * 1024
	defaultDNSDomain     = "one.one.one.one"
	defaultDNSServer     = "1.1.1.1"
	userAgent            = "amnezia-node-agent-check/1"
)

// VerifyExit runs a source-bound HTTP egress-IP echo check and a source-bound
// UDP/TCP DNS query against dnsPrimary from the specified EgressIPv4.
func VerifyExit(ctx context.Context, req types.VerifyExitRequest) types.VerifyExitResponse {
	return verifyExit(ctx, req, true)
}

func verifyExit(ctx context.Context, req types.VerifyExitRequest, publicOnly bool) types.VerifyExitResponse {
	resp := types.VerifyExitResponse{
		EgressIPv4: req.EgressIPv4,
	}

	localAddr, err := types.ParseIPv4(req.EgressIPv4)
	if err != nil {
		resp.HTTPError = err.Error()
		resp.DNSError = err.Error()
		return resp
	}
	localIP := net.IP(localAddr.AsSlice())

	timeout := defaultVerifyTimeout
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
		if timeout > 30*time.Second {
			timeout = 30 * time.Second
		}
	}

	if strings.TrimSpace(req.ProbeURL) == "" {
		resp.HTTPError = "probeUrl is required"
	} else {
		httpRes := runHttpCheck(ctx, types.HttpCheckRequest{
			EgressIPv4: req.EgressIPv4,
			URL:        req.ProbeURL,
			Method:     http.MethodGet,
			TimeoutMs:  int(timeout.Milliseconds()),
		}, publicOnly)
		resp.HTTPLatencyMs = httpRes.LatencyMs
		if httpRes.Error != "" {
			resp.HTTPError = httpRes.Error
		} else if httpRes.Status < 200 || httpRes.Status >= 300 {
			resp.HTTPError = fmt.Sprintf("HTTP %d", httpRes.Status)
		} else {
			observed := strings.TrimSpace(httpRes.Body)
			if parsed, pErr := netip.ParseAddr(observed); pErr != nil || !parsed.Is4() {
				resp.HTTPError = "probe did not return a plain IPv4 address"
			} else {
				resp.ObservedIP = parsed.String()
				resp.IPMatch = resp.ObservedIP == localAddr.String()
				if !resp.IPMatch {
					resp.HTTPError = fmt.Sprintf("egress IP mismatch: observed %s, expected %s", resp.ObservedIP, localAddr.String())
				}
			}
		}
	}

	dnsTarget := strings.TrimSpace(req.DNSServer)
	if dnsTarget == "" {
		dnsTarget = defaultDNSServer
	}
	dnsHostPort, err := normalizeHostPort(dnsTarget, "53")
	if err != nil {
		resp.DNSServer = dnsTarget
		resp.DNSError = err.Error()
		return resp
	}
	resp.DNSServer = dnsHostPort

	if publicOnly {
		dnsHost, _, _ := net.SplitHostPort(dnsHostPort)
		if dnsAddr, pErr := netip.ParseAddr(dnsHost); pErr != nil || !IsPublicUnicast(dnsAddr) {
			resp.DNSError = fmt.Sprintf("refused non-public dns server %s", dnsHost)
			return resp
		}
	}

	domain := strings.TrimSpace(req.DNSDomain)
	if domain == "" {
		domain = defaultDNSDomain
	}

	dnsStart := time.Now()
	dnsErr := queryDNSFromSource(ctx, localIP, dnsHostPort, domain, timeout)
	resp.DNSLatencyMs = time.Since(dnsStart).Milliseconds()
	if dnsErr != nil {
		resp.DNSError = types.ClipDetail(dnsErr.Error(), 240)
	} else {
		resp.DNSOK = true
	}

	resp.OK = resp.IPMatch && resp.DNSOK
	return resp
}

// RunHttpCheck performs a source-bound HTTP request and enforces a public-unicast SSRF guard
// at dial time so admin-supplied service checks cannot reach loopback, link-local, or RFC1918 hosts.
func RunHttpCheck(ctx context.Context, req types.HttpCheckRequest) types.HttpCheckResponse {
	return runHttpCheck(ctx, req, true)
}

func runHttpCheck(ctx context.Context, req types.HttpCheckRequest, publicOnly bool) types.HttpCheckResponse {
	started := time.Now()
	resp := types.HttpCheckResponse{Headers: map[string]string{}}

	localAddr, err := types.ParseIPv4(req.EgressIPv4)
	if err != nil {
		resp.Error = err.Error()
		return resp
	}

	parsedURL, err := url.Parse(strings.TrimSpace(req.URL))
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" {
		resp.Error = "invalid http/https url"
		return resp
	}

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}

	timeout := defaultHttpTimeout
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
		if timeout > 30*time.Second {
			timeout = 30 * time.Second
		}
	}

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	dialer := &net.Dialer{
		LocalAddr: &net.TCPAddr{IP: net.IP(localAddr.AsSlice())},
		Timeout:   timeout,
	}
	if publicOnly {
		dialer.Control = func(_network, address string, _c syscall.RawConn) error {
			host, _, splitErr := net.SplitHostPort(address)
			if splitErr != nil {
				return splitErr
			}
			addr, parseErr := netip.ParseAddr(host)
			if parseErr != nil {
				return fmt.Errorf("refused non-IP dial target %q", host)
			}
			if !IsPublicUnicast(addr) {
				return fmt.Errorf("refused non-public address %s", addr.String())
			}
			return nil
		}
	}

	transport := &http.Transport{
		DialContext: func(dctx context.Context, _network, addr string) (net.Conn, error) {
			return dialer.DialContext(dctx, "tcp4", addr)
		},
		DisableKeepAlives:     true,
		TLSHandshakeTimeout:   timeout,
		ResponseHeaderTimeout: timeout,
	}
	defer transport.CloseIdleConnections()

	follow := true
	if req.FollowRedirects != nil {
		follow = *req.FollowRedirects
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
	}
	if !follow {
		client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}

	httpReq, err := http.NewRequestWithContext(reqCtx, method, parsedURL.String(), nil)
	if err != nil {
		resp.Error = types.ClipDetail(err.Error(), 240)
		resp.LatencyMs = time.Since(started).Milliseconds()
		return resp
	}
	httpReq.Header.Set("User-Agent", userAgent)
	httpReq.Header.Set("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	httpResp, err := client.Do(httpReq)
	resp.LatencyMs = time.Since(started).Milliseconds()
	if err != nil {
		resp.Error = types.ClipDetail(err.Error(), 240)
		return resp
	}
	defer httpResp.Body.Close()

	resp.Status = httpResp.StatusCode
	if httpResp.Request != nil && httpResp.Request.URL != nil {
		resp.FinalURL = httpResp.Request.URL.String()
	}
	for k, vals := range httpResp.Header {
		if len(vals) > 0 {
			resp.Headers[strings.ToLower(k)] = vals[0]
		}
	}

	limited := io.LimitReader(httpResp.Body, maxHttpBodyBytes)
	bodyBytes, readErr := io.ReadAll(limited)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		resp.Error = types.ClipDetail(readErr.Error(), 240)
		return resp
	}
	resp.Body = string(bodyBytes)
	return resp
}

// IsPublicUnicast returns true only for routable public IPv4/IPv6 unicast addresses.
func IsPublicUnicast(addr netip.Addr) bool {
	if addr.Is4In6() {
		addr = addr.Unmap()
	}
	if !addr.IsValid() || addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() || addr.IsMulticast() || addr.IsUnspecified() {
		return false
	}
	if addr.Is4() {
		cgnat := netip.MustParsePrefix("100.64.0.0/10")
		if cgnat.Contains(addr) {
			return false
		}
	}
	return addr.IsGlobalUnicast()
}

func normalizeHostPort(raw, defaultPort string) (string, error) {
	if _, _, err := net.SplitHostPort(raw); err == nil {
		host, port, _ := net.SplitHostPort(raw)
		if _, err := types.ParseIPv4(host); err != nil {
			return "", fmt.Errorf("invalid IPv4 host %q", host)
		}
		if port == "" {
			port = defaultPort
		}
		return net.JoinHostPort(host, port), nil
	}
	addr, err := types.ParseIPv4(raw)
	if err != nil {
		return "", err
	}
	return net.JoinHostPort(addr.String(), defaultPort), nil
}

func queryDNSFromSource(ctx context.Context, localIP net.IP, serverHostPort, domain string, timeout time.Duration) error {
	id, pkt, err := buildDNSAQuery(domain)
	if err != nil {
		return err
	}

	udpErr := queryDNSUDP(ctx, localIP, serverHostPort, id, pkt, timeout)
	if udpErr == nil {
		return nil
	}

	tcpErr := queryDNSTCP(ctx, localIP, serverHostPort, id, pkt, timeout)
	if tcpErr == nil {
		return nil
	}
	return fmt.Errorf("udp: %v; tcp: %v", udpErr, tcpErr)
}

func queryDNSUDP(ctx context.Context, localIP net.IP, serverHostPort string, id uint16, pkt []byte, timeout time.Duration) error {
	dialer := &net.Dialer{
		LocalAddr: &net.UDPAddr{IP: localIP},
		Timeout:   timeout,
	}
	conn, err := dialer.DialContext(ctx, "udp4", serverHostPort)
	if err != nil {
		return err
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write(pkt); err != nil {
		return err
	}
	buf := make([]byte, 1500)
	n, err := conn.Read(buf)
	if err != nil {
		return err
	}
	return validateDNSResponse(id, buf[:n])
}

func queryDNSTCP(ctx context.Context, localIP net.IP, serverHostPort string, id uint16, pkt []byte, timeout time.Duration) error {
	dialer := &net.Dialer{
		LocalAddr: &net.TCPAddr{IP: localIP},
		Timeout:   timeout,
	}
	conn, err := dialer.DialContext(ctx, "tcp4", serverHostPort)
	if err != nil {
		return err
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(timeout))
	framed := make([]byte, 2+len(pkt))
	binary.BigEndian.PutUint16(framed[:2], uint16(len(pkt)))
	copy(framed[2:], pkt)
	if _, err := conn.Write(framed); err != nil {
		return err
	}

	var lenBuf [2]byte
	if _, err := io.ReadFull(conn, lenBuf[:]); err != nil {
		return err
	}
	msgLen := int(binary.BigEndian.Uint16(lenBuf[:]))
	if msgLen < 12 || msgLen > 4096 {
		return fmt.Errorf("unexpected DNS TCP frame length %d", msgLen)
	}
	respBuf := make([]byte, msgLen)
	if _, err := io.ReadFull(conn, respBuf); err != nil {
		return err
	}
	return validateDNSResponse(id, respBuf)
}

func buildDNSAQuery(domain string) (uint16, []byte, error) {
	trimmed := strings.TrimSuffix(strings.TrimSpace(domain), ".")
	if trimmed == "" {
		return 0, nil, fmt.Errorf("empty DNS domain")
	}

	var idBytes [2]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		idBytes = [2]byte{0x13, 0x37}
	}
	id := binary.BigEndian.Uint16(idBytes[:])

	pkt := make([]byte, 12, 64)
	binary.BigEndian.PutUint16(pkt[0:2], id)
	binary.BigEndian.PutUint16(pkt[2:4], 0x0100)
	binary.BigEndian.PutUint16(pkt[4:6], 1)

	for _, label := range strings.Split(trimmed, ".") {
		if len(label) == 0 || len(label) > 63 {
			return 0, nil, fmt.Errorf("invalid DNS label %q in %q", label, domain)
		}
		pkt = append(pkt, byte(len(label)))
		pkt = append(pkt, []byte(label)...)
	}
	pkt = append(pkt, 0)
	pkt = binary.BigEndian.AppendUint16(pkt, 1)
	pkt = binary.BigEndian.AppendUint16(pkt, 1)
	return id, pkt, nil
}

func validateDNSResponse(expectedID uint16, resp []byte) error {
	if len(resp) < 12 {
		return fmt.Errorf("DNS response too short (%d bytes)", len(resp))
	}
	gotID := binary.BigEndian.Uint16(resp[0:2])
	if gotID != expectedID {
		return fmt.Errorf("DNS ID mismatch (got %d, want %d)", gotID, expectedID)
	}
	flags := binary.BigEndian.Uint16(resp[2:4])
	if flags&0x8000 == 0 {
		return fmt.Errorf("DNS response missing QR bit")
	}
	if flags&0x0200 != 0 {
		return fmt.Errorf("DNS UDP response truncated")
	}
	rcode := flags & 0x000f
	if rcode != 0 {
		return fmt.Errorf("DNS error rcode=%d", rcode)
	}
	ancount := binary.BigEndian.Uint16(resp[6:8])
	if ancount < 1 {
		return fmt.Errorf("DNS returned 0 answer records")
	}
	return nil
}

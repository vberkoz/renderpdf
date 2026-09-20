package main

import (
	"context"
	"net"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	blockedCIDRStrings = []string{
		"0.0.0.0/8",          // "This network" (RFC 1122)
		"10.0.0.0/8",         // Private-use networks (RFC 1918)
		"100.64.0.0/10",      // Shared address space / Carrier Grade NAT (RFC 6598)
		"127.0.0.0/8",        // Loopback (RFC 1122)
		"169.254.0.0/16",     // Link-local / AWS metadata (RFC 3927)
		"172.16.0.0/12",      // Private-use networks (RFC 1918)
		"192.0.0.0/24",       // IETF Protocol Assignments (RFC 6890)
		"192.0.2.0/24",       // TEST-NET-1 (RFC 5737)
		"192.88.99.0/24",     // 6to4 Relay Anycast (RFC 7526)
		"192.168.0.0/16",     // Private-use networks (RFC 1918)
		"198.18.0.0/15",      // Network interconnect benchmark (RFC 2544)
		"198.51.100.0/24",    // TEST-NET-2 (RFC 5737)
		"203.0.113.0/24",     // TEST-NET-3 (RFC 5737)
		"224.0.0.0/4",        // Multicast (RFC 5771)
		"240.0.0.0/4",        // Reserved for future use (RFC 1112)
		"255.255.255.255/32", // Limited broadcast
		"::1/128",            // IPv6 Loopback
		"::/128",             // IPv6 Unspecified
		"fc00::/7",           // IPv6 Unique local addresses (RFC 4193)
		"fe80::/10",          // IPv6 Link-local unicast (RFC 4291)
		"ff00::/8",           // IPv6 Multicast
	}

	blockedIPNets []*net.IPNet
)

func init() {
	for _, cidr := range blockedCIDRStrings {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err == nil && ipNet != nil {
			blockedIPNets = append(blockedIPNets, ipNet)
		}
	}
}

// isBlockedIP checks if an IP belongs to any private, loopback, link-local,
// multicast, or reserved CIDR range.
func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	if ipv4 := ip.To4(); ipv4 != nil {
		ip = ipv4
		if ipv4.IsPrivate() || ipv4.IsLinkLocalUnicast() || ipv4.Equal(net.ParseIP("169.254.169.254")) {
			return true
		}
	} else if ip.IsPrivate() {
		return true
	}

	for _, ipNet := range blockedIPNets {
		if ipNet.Contains(ip) {
			return true
		}
	}
	return false
}

// parseAlternativeIP attempts to parse non-standard representations of IPv4
// such as single integer values (e.g. "2130706433"), hex ("0x7f000001"), or octal ("0177.0.0.1").
func parseAlternativeIP(host string) net.IP {
	host = strings.TrimSpace(host)
	if host == "" {
		return nil
	}

	// Check single integer (decimal, hex with 0x, or octal with 0 prefix)
	if val, err := strconv.ParseUint(host, 0, 32); err == nil {
		return net.IPv4(byte(val>>24), byte(val>>16), byte(val>>8), byte(val))
	}

	// Check dotted octal or hex notation like 0177.0.0.1 or 0x7f.0.0.1
	parts := strings.Split(host, ".")
	if len(parts) == 4 {
		var octets [4]byte
		valid := true
		for i, part := range parts {
			val, err := strconv.ParseUint(strings.TrimSpace(part), 0, 8)
			if err != nil {
				valid = false
				break
			}
			octets[i] = byte(val)
		}
		if valid {
			return net.IPv4(octets[0], octets[1], octets[2], octets[3])
		}
	}

	return nil
}

type dnsResolverFunc func(ctx context.Context, host string) ([]net.IP, error)

var defaultDNSResolver dnsResolverFunc = func(ctx context.Context, host string) ([]net.IP, error) {
	var r net.Resolver
	return r.LookupIP(ctx, "ip", host)
}

type networkSecurityFilter struct {
	mu       sync.RWMutex
	cache    map[string]cacheEntry
	resolver dnsResolverFunc
}

type cacheEntry struct {
	allowed   bool
	expiresAt time.Time
}

func newNetworkSecurityFilter(resolver dnsResolverFunc) *networkSecurityFilter {
	if resolver == nil {
		resolver = defaultDNSResolver
	}
	return &networkSecurityFilter{
		cache:    make(map[string]cacheEntry),
		resolver: resolver,
	}
}

// isAllowedURL inspects a URL requested by Chrome to determine if it is safe to load.
// Allows:
//   - In-memory data, blob, and about schemes.
//   - Local package file assets residing within /tmp/renderpdf-package-*.
//   - Public HTTP(S) destinations whose resolved IP addresses are strictly outside internal ranges.
//
// Blocks:
//   - Loopback targets (127.0.0.1, localhost, ::1).
//   - Lambda runtime API (127.0.0.1:9001).
//   - Cloud metadata / link-local addresses (169.254.0.0/16).
//   - Private RFC 1918 / CGNAT networks.
//   - Local filesystem paths outside the active unpacked package directory.
func (f *networkSecurityFilter) isAllowedURL(rawURL string) bool {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return false
	}

	parsed, err := url.Parse(rawURL)
	if err != nil || parsed == nil {
		return false
	}

	scheme := strings.ToLower(parsed.Scheme)
	switch scheme {
	case "data", "blob", "about":
		return true

	case "file":
		// Only allow assets located within the extracted package directory
		cleanPath := filepath.Clean(parsed.Path)
		return strings.HasPrefix(cleanPath, "/tmp/renderpdf-package-")

	case "http", "https":
		// Must validate target host
		return f.isAllowedHTTPHost(parsed.Hostname())

	default:
		return false
	}
}

func (f *networkSecurityFilter) isAllowedHTTPHost(host string) bool {
	host = strings.TrimSpace(host)
	if host == "" {
		return false
	}

	lowerHost := strings.ToLower(host)
	if lowerHost == "localhost" || strings.HasSuffix(lowerHost, ".localhost") || strings.HasSuffix(lowerHost, ".local") {
		return false
	}

	// 1. Literal IP addresses (IPv4 / IPv6)
	if ip := net.ParseIP(host); ip != nil {
		return !isBlockedIP(ip)
	}

	// 2. Alternative integer, hex, or octal IP encodings
	if ip := parseAlternativeIP(host); ip != nil {
		return !isBlockedIP(ip)
	}

	// 3. Check cached DNS validation result
	f.mu.RLock()
	if entry, found := f.cache[lowerHost]; found && time.Now().Before(entry.expiresAt) {
		f.mu.RUnlock()
		return entry.allowed
	}
	f.mu.RUnlock()

	// 4. Resolve domain name and ensure all returned IP addresses are public
	lookupCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	ips, err := f.resolver(lookupCtx, lowerHost)
	allowed := false
	if err == nil && len(ips) > 0 {
		allSafe := true
		for _, ip := range ips {
			if isBlockedIP(ip) {
				allSafe = false
				break
			}
		}
		allowed = allSafe
	}

	// 5. Update DNS cache
	f.mu.Lock()
	if len(f.cache) > 1000 {
		f.cache = make(map[string]cacheEntry)
	}
	f.cache[lowerHost] = cacheEntry{
		allowed:   allowed,
		expiresAt: time.Now().Add(60 * time.Second),
	}
	f.mu.Unlock()

	return allowed
}

var defaultNetworkFilter = newNetworkSecurityFilter(nil)

// isSafeNetworkURL evaluates a URL using the default network security filter.
func isSafeNetworkURL(rawURL string) bool {
	return defaultNetworkFilter.isAllowedURL(rawURL)
}

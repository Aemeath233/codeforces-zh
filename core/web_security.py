from ipaddress import ip_address, ip_network
from urllib.parse import urlsplit

_VPN_NETWORKS = tuple(ip_network(net) for net in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7",
))


def validate_proxy_origin(value):
    """Allow HTTPS origins, or a private literal IP for an encrypted VPN gateway.

    This only controls Origin checks. It does not enable remote listening or
    authenticate a request: the gateway must restrict the listening interface.
    """
    value = value.rstrip("/")
    if not value:
        return ""
    try:
        parsed = urlsplit(value)
        parsed.port  # Reject malformed/out-of-range ports before startup.
        valid = (parsed.scheme in ("http", "https") and parsed.hostname
                 and not (parsed.username or parsed.password or parsed.path
                          or parsed.query or parsed.fragment))
        if valid and parsed.scheme == "http":
            address = ip_address(parsed.hostname)
            valid = any(address in network for network in _VPN_NETWORKS)
        if valid:
            return value
    except ValueError:
        pass
    raise RuntimeError("CF_MIRROR_PUBLIC_ORIGIN requires HTTPS or a private VPN IP origin without a path")

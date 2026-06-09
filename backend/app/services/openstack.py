import openstack

from app.config import settings

_conn: openstack.connection.Connection | None = None


def reset_connection() -> None:
    """Drop the cached OpenStack connection; next call to get_connection() will reconnect."""
    global _conn
    if _conn is not None:
        try:
            _conn.close()
        except Exception:
            pass
    _conn = None


def get_connection() -> openstack.connection.Connection:
    global _conn
    if _conn is None:
        kwargs = dict(
            auth_url=settings.os_auth_url,
            username=settings.os_username,
            password=settings.os_password,
            project_name=settings.os_project_name,
            user_domain_name=settings.os_user_domain_name,
            project_domain_name=settings.os_project_domain_name,
            # Force public endpoints — PCD's catalog internal URLs are k8s-only.
            interface="public",
        )
        if settings.os_region_name:
            kwargs["region_name"] = settings.os_region_name
        _conn = openstack.connect(**kwargs)
    return _conn

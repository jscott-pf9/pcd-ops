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
        _conn = openstack.connect(
            auth_url=settings.os_auth_url,
            username=settings.os_username,
            password=settings.os_password,
            project_name=settings.os_project_name,
            user_domain_name=settings.os_user_domain_name,
            project_domain_name=settings.os_project_domain_name,
            # Force public endpoints — PCD's catalog internal URLs are k8s-only.
            interface="public",
        )
        # Passing region_name to openstack.connect() causes a validation error
        # when no OS_* env vars are set: the SDK validates against the "envvars"
        # cloud profile which has no configured regions. Setting it on the
        # CloudRegion config dict after connecting bypasses that validation while
        # still routing all service catalog lookups to the correct region.
        if settings.os_region_name:
            _conn.config.config["region_name"] = settings.os_region_name
    return _conn

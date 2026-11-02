from app.appliance import config_env
from app.appliance import connection as pcd


def test_parse_quotes_and_escapes():
    env = config_env.parse(
        "# comment\n"
        "PCD_INSTANCE_NAME='it'\\''s-a-test'\n"
        "AI_URL='http://10.0.0.9:11434'\n"
        "export AI_MODEL=\"llama3.1:8b\"\n"
        "BARE=value # trailing comment\n"
        "not a line\n"
        "1BAD='x'\n"
    )
    assert env == {"PCD_INSTANCE_NAME": "it's-a-test", "AI_URL": "http://10.0.0.9:11434",
                   "AI_MODEL": "llama3.1:8b", "BARE": "value"}


def test_load_drops_empty_values(tmp_path):
    f = tmp_path / "config.env"
    f.write_text("AI_URL=''\nAI_MODEL='x'\n")
    assert config_env.load(f) == {"AI_MODEL": "x"}


def test_missing_file_is_empty(tmp_path):
    assert config_env.load(tmp_path / "nope") == {}


def test_connection_comes_from_config_env():
    conn = pcd.load()
    assert conn.auth_url == "https://pcd.example.com/keystone/v3"
    assert (conn.region, conn.project_id, conn.project_name) == ("lab", "proj-123", "service")
    assert conn.instance_name == "pcd-ops-01"
    assert conn.from_config_env and conn.configured


def test_config_env_wins_over_saved_connection():
    pcd.save(auth_url="https://old/keystone/v3", region="old")
    conn = pcd.load()
    assert conn.auth_url == "https://pcd.example.com/keystone/v3"
    assert conn.region == "lab"


def test_saved_connection_without_config_env(isolated):
    (isolated / "config.env").unlink()
    pcd.save(auth_url="https://other/keystone/v3", project_name="admin", region="r1",
             project_domain="corp")
    conn = pcd.load()
    assert (conn.auth_url, conn.project_name, conn.region) == (
        "https://other/keystone/v3", "admin", "r1")
    assert conn.project_domain == "corp"
    assert not conn.from_config_env and conn.configured

from app.services.ssh import parse_dimm_mb, parse_lscpu

DMIDECODE = """\
Memory Device
\tTotal Width: 64 bits
\tSize: 32 GB
\tLocator: DIMM 0
Memory Device
\tSize: No Module Installed
Memory Device
\tSize: 32 GiB
Memory Device
\tSize: 16384 MB
\tVolatile Size: 16 GB
"""


def test_parse_dimm_mb():
    assert parse_dimm_mb(DMIDECODE) == (32 + 32 + 16) * 1024
    assert parse_dimm_mb("") is None
    assert parse_dimm_mb("\tSize: No Module Installed\n") is None


LSCPU = """\
Architecture:                            x86_64
Vendor ID:                               AuthenticAMD
BIOS Vendor ID:                          Advanced Micro Devices, Inc.
Model name:                              AMD Ryzen 7 5700U with Radeon Graphics
BIOS Model name:                         AMD Ryzen 7 5700U  Unknown CPU @ 1.8GHz
Thread(s) per core:                      2
Core(s) per socket:                      8
Socket(s):                               1
"""


def test_parse_lscpu():
    assert parse_lscpu(LSCPU) == {
        "cpu_model": "AMD Ryzen 7 5700U with Radeon Graphics",
        "cpu_sockets": 1,
        "cpu_cores": 8,
        "cpu_threads": 2,
    }
    assert parse_lscpu("") == {}

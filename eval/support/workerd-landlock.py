#!/usr/bin/env python3
"""Exec native workerd with a fail-closed, inherited TCP port allowlist.

Linux ABI contract: https://docs.kernel.org/userspace-api/landlock.html
No namespace, root, compiler or third-party Python module is needed.
"""
import ctypes
import os
import platform
import sys


def main():
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "aarch64"):
        raise RuntimeError("eval isolation requires Linux x86_64/aarch64 and Landlock ABI >= 4")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long

    def checked(result):
        if result < 0:
            raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
        return result

    abi = checked(libc.syscall(444, 0, 0, 1))
    if abi < 4:
        raise RuntimeError(f"Landlock ABI {abi}; TCP isolation requires ABI >= 4")
    # Only sockets held by this eval harness and its descendants qualify.
    # Never enumerate unrelated processes' listening ports.
    owner = int(os.environ["EVAL_NETWORK_OWNER_PID"])
    parents = {}
    for entry in os.listdir("/proc"):
        if entry.isdecimal():
            try:
                with open(f"/proc/{entry}/stat") as stream:
                    parents[int(entry)] = int(stream.read().rsplit(")", 1)[1].split()[1])
            except FileNotFoundError:
                continue
    def owned(pid):
        seen = set()
        while pid > 1 and pid not in seen:
            if pid == owner:
                return True
            seen.add(pid)
            pid = parents.get(pid, 0)
        return False
    if not owned(os.getppid()):
        raise RuntimeError("eval harness is not a launcher ancestor")
    inodes = set()
    for pid in parents:
        if not owned(pid):
            continue
        try:
            fds = os.listdir(f"/proc/{pid}/fd")
        # A non-dumpable descendant (a sandboxed agent CLI) hides its fds. Its
        # ports stay denied, which fails closed for this allowlist.
        except (FileNotFoundError, PermissionError):
            continue
        for fd in fds:
            try:
                target = os.readlink(f"/proc/{pid}/fd/{fd}")
            except (FileNotFoundError, PermissionError):
                continue
            if target.startswith("socket:["):
                inodes.add(target[8:-1])
    proxy_port = int(os.environ["EVAL_WORKERD_PROXY_PORT"])
    if not 1 <= proxy_port <= 65535:
        raise RuntimeError("invalid reserved proxy port")
    ports = {proxy_port}
    for table in ("tcp", "tcp6"):
        with open(f"/proc/net/{table}") as stream:
            for line in stream.readlines()[1:]:
                row = line.split()
                address, port = row[1].split(":")
                if row[3] == "0A" and row[9] in inodes:
                    if address not in ("0100007F", "00000000000000000000000001000000"):
                        continue
                    ports.add(int(port, 16))
    class Ruleset(ctypes.Structure):
        _fields_ = [("fs", ctypes.c_uint64), ("net", ctypes.c_uint64)]
    class Port(ctypes.Structure):
        _fields_ = [("access", ctypes.c_uint64), ("port", ctypes.c_uint64)]
    connect_tcp = 1 << 1
    rules = Ruleset(0, connect_tcp)
    fd = checked(libc.syscall(444, ctypes.byref(rules), ctypes.sizeof(rules), 0))
    try:
        for port in ports:
            rule = Port(connect_tcp, port)
            checked(libc.syscall(445, fd, 2, ctypes.byref(rule), 0))
        checked(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
        checked(libc.syscall(446, fd, 0))
    finally:
        os.close(fd)
    print(f"[eval isolation] kernel={platform.release()} Landlock ABI={abi} TCP ports={sorted(ports)}", file=sys.stderr)
    args = [arg.replace("--socket-addr=entry=127.0.0.1:0", f"--socket-addr=entry=127.0.0.1:{proxy_port}") for arg in sys.argv[1:]]
    os.execv(os.environ["EVAL_NATIVE_WORKERD"], [os.environ["EVAL_NATIVE_WORKERD"], *args])



if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"[eval isolation] REFUSED: {error}", file=sys.stderr)
        sys.exit(125)

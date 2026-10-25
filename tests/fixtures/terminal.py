#!/usr/bin/env python3
"""阶段一可控 fixture；所有子进程由测试明确管理。"""
import os
import signal
import subprocess
import sys
import time

mode = sys.argv[1]
if mode == 'wizard':
    print('Name? ', end='', flush=True)
    name = sys.stdin.readline().rstrip('\r\n')
    print('HELLO:' + name, flush=True)
    print('Age? ', end='', flush=True)
    age = sys.stdin.readline().rstrip('\r\n')
    print('ANSWER:' + name + ':' + age, flush=True)
elif mode == 'split':
    sys.stdout.write('\033['); sys.stdout.flush(); time.sleep(0.03)
    sys.stdout.write('32mServer lis'); sys.stdout.flush(); time.sleep(0.03)
    sys.stdout.write('tening\033[0m'); sys.stdout.flush(); time.sleep(0.5)
elif mode == 'long':
    delay = float(sys.argv[2]) if len(sys.argv) > 2 else 0.1
    print('BOOT:' + str(os.getpid()), flush=True)
    time.sleep(delay)
    for i in range(5):
        print('STEP:' + str(i) + ':汉字🙂' * 30, flush=True)
        time.sleep(0.015)
    print('FINAL_ERROR: deliberate nonzero', flush=True)
    sys.exit(7)
elif mode == 'flood':
    for i in range(100):
        print(('汉🙂' + str(i)) * 100, flush=True)
    print('TAIL_DONE', flush=True)
elif mode == 'ignore-term':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    print('READY:' + str(os.getpid()), flush=True)
    while True:
        time.sleep(0.05)
elif mode == 'ctrl':
    signal.signal(signal.SIGINT, lambda *_: (print('INTERRUPTED', flush=True), sys.exit(0)))
    print('CTRL_READY', flush=True)
    while True:
        time.sleep(0.05)
elif mode in ('quiet', 'ignore-hup'):
    if mode == 'ignore-hup':
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
    print('READY:' + str(os.getpid()), flush=True)
    while True:
        time.sleep(0.05)
elif mode == 'group':
    child = subprocess.Popen([sys.executable, '-u', '-c', 'import time; time.sleep(600)'])
    stopping = False
    def stop(*_):
        global stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    print('GROUP:' + str(os.getpid()) + ':' + str(child.pid), flush=True)
    while not stopping:
        time.sleep(0.02)
    try:
        child.wait(timeout=1)
    except subprocess.TimeoutExpired:
        child.kill(); child.wait()
    print('GROUP_REAPED', flush=True)
elif mode == 'tty':
    print('TTY:' + str(os.isatty(0)) + ':' + str(os.isatty(1)) + ':' + str(os.getpgrp()) + ':' + str(os.getsid(0)), flush=True)
elif mode == 'echo':
    for line in sys.stdin:
        print('GOT:' + line.rstrip('\r\n'), flush=True)
else:
    raise ValueError(mode)

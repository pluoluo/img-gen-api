"""Prepare or enable an independent user nginx HTTPS entry for image-api."""
import argparse
from pathlib import Path
import shlex
import shutil
import ssl
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", default="fn.pluoluo.top")
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--upstream-port", type=int, default=8766)
    parser.add_argument("--ipv6", action="store_true", help="Also listen on IPv6 for domains with AAAA records")
    parser.add_argument("--cert-dir", type=Path, required=True)
    parser.add_argument("--cert-name", default="server.crt")
    parser.add_argument("--key-name", default="server.key")
    parser.add_argument("--proxy-timeout", type=int, required=True, help="Approved proxy read/send idle timeout in seconds")
    parser.add_argument("--enable", action="store_true", help="Enable services after preparing and validating configuration")
    args = parser.parse_args()
    nginx = shutil.which("nginx") or "/usr/sbin/nginx"
    if not Path(nginx).is_file():
        parser.error("nginx is required")
    if not all(part and all(char.isalnum() or char == "-" for char in part) for part in args.domain.split(".")):
        parser.error("Invalid domain")
    if not (1024 < args.port < 65536 and 0 < args.upstream_port < 65536 and args.proxy_timeout > 0):
        parser.error("Invalid port or approved timeout")
    cert_dir = args.cert_dir.expanduser().absolute()
    cert, key = cert_dir / args.cert_name, cert_dir / args.key_name
    ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(cert, key)
    subprocess.run(["openssl", "verify", "-verify_hostname", args.domain, "-untrusted", str(cert), str(cert)], check=True)

    config_dir = Path.home() / ".config" / "image-api" / "https"
    state_dir = Path.home() / ".local" / "state" / "image-api-https"
    unit_dir = Path.home() / ".config" / "systemd" / "user"
    for folder in (config_dir, state_dir, unit_dir):
        folder.mkdir(parents=True, exist_ok=True)
    config = config_dir / "nginx.conf"
    ipv6_listen = f"        listen [::]:{args.port} ssl ipv6only=on;\n" if args.ipv6 else ""
    content = f'''pid "{state_dir}/nginx.pid";
error_log "{state_dir}/error.log";
events {{ }}
http {{
    access_log "{state_dir}/access.log";
    client_body_temp_path "{state_dir}/body";
    proxy_temp_path "{state_dir}/proxy";
    map $http_upgrade $connection_upgrade {{
        default upgrade;
        '' close;
    }}
    server {{
        listen 0.0.0.0:{args.port} ssl;
{ipv6_listen}        server_name {args.domain};
        ssl_certificate "{cert}";
        ssl_certificate_key "{key}";
        ssl_protocols TLSv1.2 TLSv1.3;
        # Preserve application upload validation; add no proxy body-size cap.
        client_max_body_size 0;
        location / {{
            proxy_pass http://127.0.0.1:{args.upstream_port};
            proxy_http_version 1.1;
            proxy_set_header Host $http_host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto https;
            proxy_set_header X-Forwarded-Host $http_host;
            proxy_set_header X-Forwarded-Port {args.port};
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_buffering off;
            proxy_request_buffering off;
            proxy_read_timeout {args.proxy_timeout}s;
            proxy_send_timeout {args.proxy_timeout}s;
        }}
    }}
}}
'''
    def write(path, text):
        if path.exists() and path.read_text() != text:
            backup = path.with_name(path.name + f".backup-{time.time_ns()}")
            shutil.copy2(path, backup)
        path.write_text(text)

    write(config, content)
    command = f"{shlex.quote(nginx)} -p {shlex.quote(str(state_dir) + '/')} -c {shlex.quote(str(config))}"
    subprocess.run(shlex.split(command) + ["-t"], check=True)
    reload_command = f"{command} -t && exec {command} -s reload"
    write(unit_dir / "image-api-https.service", f'''[Unit]
Description=Image API HTTPS ({args.domain}:{args.port})
After=network.target image-api.service
Wants=image-api.service

[Service]
Type=simple
ExecStartPre={command} -t
ExecStart={command} -g "daemon off;"
ExecReload=/bin/sh -c {shlex.quote(reload_command)}
Restart=on-failure
NoNewPrivileges=true

[Install]
WantedBy=default.target
''')
    write(unit_dir / "image-api-https-cert.service", '''[Unit]
Description=Reload image-api HTTPS after certificate replacement

[Service]
Type=oneshot
ExecCondition=/usr/bin/systemctl --user is-active --quiet image-api-https.service
ExecStart=/usr/bin/systemctl --user reload image-api-https.service
''')
    write(unit_dir / "image-api-https-cert.path", f'''[Unit]
Description=Watch the existing image-api HTTPS certificate directory

[Path]
PathChanged={cert_dir}
PathChanged={cert.resolve()}
PathChanged={key.resolve()}
Unit=image-api-https-cert.service

[Install]
WantedBy=default.target
''')
    subprocess.run(["systemd-analyze", "--user", "verify", str(unit_dir / "image-api-https.service"), str(unit_dir / "image-api-https-cert.service"), str(unit_dir / "image-api-https-cert.path")], check=True)
    print(f"Validated configuration: {config}")
    if args.enable:
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", "image-api-https.service", "image-api-https-cert.path"], check=True)
        print(f"HTTPS ready: https://{args.domain}:{args.port}/infinite/canvas")
    else:
        print("Prepared only; the HTTPS listener has not been started.")


if __name__ == "__main__":
    main()

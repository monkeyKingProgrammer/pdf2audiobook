set -euo pipefail
test ! -e /opt/pdfeditor
test ! -e /etc/nginx/sites-available/pdfeditor.weiwei.website
sudo install -d -o ubuntu -g ubuntu /opt/pdfeditor
tar -xzf /home/ubuntu/pdfeditor-release.tgz -C /opt/pdfeditor
cd /opt/pdfeditor
python3 -m venv .venv
.venv/bin/python -m pip install --no-cache-dir -r requirements.txt
sudo install -m 0644 deploy/pdfeditor.service /etc/systemd/system/pdfeditor.service
sudo systemctl daemon-reload
sudo systemctl enable --now pdfeditor
sudo install -m 0644 deploy/nginx-http.conf /etc/nginx/sites-available/pdfeditor.weiwei.website
sudo ln -s /etc/nginx/sites-available/pdfeditor.weiwei.website /etc/nginx/sites-enabled/pdfeditor.weiwei.website
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --nginx -d pdfeditor.weiwei.website --non-interactive --agree-tos --register-unsafely-without-email
sudo install -m 0644 deploy/nginx.conf /etc/nginx/sites-available/pdfeditor.weiwei.website
sudo nginx -t
sudo systemctl reload nginx
.venv/bin/python verify.py

"""管理员登录验证邮件（QQ 邮箱 SMTP_SSL）。

SMTP 凭证来源（ISSUE-174 调整）：**管理页配置优先**（settings 表 smtp_user/smtp_auth_code），
未配置时回退 env SMTP_USER/SMTP_AUTH_CODE。授权码 = QQ 邮箱「授权码」而非登录密码。
"""
import os
import smtplib
import ssl
from email.header import Header
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

SMTP_HOST = "smtp.qq.com"
SMTP_PORT = 465


class MailNotConfigured(Exception):
    pass


def admin_email() -> str:
    return os.environ.get("ADMIN_EMAIL", "79734745@qq.com")


def send_login_mail(
    smtp_user: str,
    smtp_auth_code: str,
    to_email: str,
    body_html: str,
    qr_png: bytes,
):
    """发送确认邮件：正文含确认链接 + 内嵌二维码（cid=login_qr，与 MIMEImage 配对）。

    smtp_user / smtp_auth_code 由调用方解析好（DB 优先、env 兜底）；未配置抛 MailNotConfigured。
    """
    smtp_user = (smtp_user or "").strip()
    smtp_auth_code = (smtp_auth_code or "").strip()
    if not (smtp_user and smtp_auth_code):
        raise MailNotConfigured("SMTP 未配置（管理页需先填写 QQ 邮箱授权码）")

    msg = MIMEMultipart("related")
    msg["Subject"] = Header("管理后台登录确认（5 分钟内有效）", "utf-8")
    msg["From"] = formataddr(("权益认证中台", smtp_user))
    msg["To"] = to_email or smtp_user
    # ⚠ preamble 必须是 ASCII：smtplib.sendmail 对拍平后的整报文做 .encode('ascii')，
    # 裸非 ASCII（如中文提示语）会直接 UnicodeEncodeError（正文无碍——MIMEText 已按 utf-8 编码）。
    msg.preamble = "Please view this email with an HTML-capable mail client."
    msg.attach(MIMEText(body_html, "html", "utf-8"))
    if qr_png:
        img = MIMEImage(qr_png)
        img.add_header("Content-ID", "<login_qr>")
        img.add_header("Content-Disposition", "inline", filename="login-qr.png")
        msg.attach(img)

    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx, timeout=20) as s:
        s.login(smtp_user, smtp_auth_code)
        s.sendmail(smtp_user, [msg["To"]], msg.as_string())

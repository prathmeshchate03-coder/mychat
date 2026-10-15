// JenChat mail relay: a tiny Google Apps Script web app that sends the verification and password-reset mails
// from YOUR Gmail account. (Render's free plan blocks normal SMTP, so the site calls this over HTTPS instead.)
// Free Gmail accounts can send about 100 mails a day this way.
//
// SET UP (once):
//  1. Go to script.google.com, press "New project", delete the sample code and paste this whole file.
//  2. Change SECRET below to a long random text (30+ letters and numbers) and SITE to your site address.
//  3. Press Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone. Press Deploy.
//  4. Google asks you to authorise the script to send mail. Allow it (Advanced > Go to project > Allow).
//  5. Copy the "Web app URL" (it ends with /exec).
//  6. In Render > Environment add:  MAIL_RELAY_URL = that URL   and   MAIL_RELAY_SECRET = the same SECRET as below.
//  If you change this code later, use Deploy > Manage deployments > Edit > New version, or the URL keeps the old code.

const SECRET = 'PUT-A-LONG-RANDOM-SECRET-HERE';
const SITE = 'https://your-site.onrender.com';   // no slash at the end. Mail links must start with this.
const BRAND = 'JenChat';

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.secret !== SECRET) return out({ ok: false, error: 'wrong secret' });
    if (!/^[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}$/.test(String(d.to))) return out({ ok: false, error: 'bad address' });
    if (String(d.link).indexOf(SITE + '/') !== 0) return out({ ok: false, error: 'link does not start with SITE' });
    const name = String(d.name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20);
    let subject, body;
    if (d.kind === 'verify') {
      subject = 'Confirm your ' + BRAND + ' account';
      body = 'Hi ' + name + ',\n\nOpen this link to confirm your email and make your ' + BRAND + ' account permanent:\n\n' + d.link +
        '\n\nThe link works for 24 hours. If you did not create an account, just ignore this mail.\n';
    } else if (d.kind === 'reset') {
      subject = 'Reset your ' + BRAND + ' password';
      body = 'Hi ' + name + ',\n\nOpen this link to choose a new password:\n\n' + d.link +
        '\n\nThe link works for 1 hour. If you did not ask for this, ignore this mail. Your password stays the same.\n';
    } else {
      return out({ ok: false, error: 'unknown kind' });
    }
    MailApp.sendEmail({ to: d.to, subject: subject, body: body, name: BRAND });
    return out({ ok: true, left: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

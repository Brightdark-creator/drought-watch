/**
 * qr.js — "Open on your phone": a QR code of the page that is open right now
 * (on the map page that includes the chosen place, so a judge can scan it and
 * see the same result). The small QR library is downloaded only when someone
 * opens the box, and the code is made on this computer: the address is not
 * sent anywhere.
 */
const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
let loading = null;

function loadLib() {
  if (window.qrcode) return Promise.resolve();
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = QR_LIB;
    s.onload = resolve;
    s.onerror = () => { loading = null; reject(new Error('QR library could not be loaded')); };
    document.head.appendChild(s);
  });
  return loading;
}

/** Fills `box` with a QR code of the current address each time `details` opens. */
export function setupQr(details, box, altText) {
  details.addEventListener('toggle', async () => {
    if (!details.open) return;
    try {
      await loadLib();
      const qr = window.qrcode(0, 'M');
      qr.addData(location.href);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      const svg = box.querySelector('svg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', altText());
    } catch {
      box.textContent = location.href; // no QR: at least the address to type
    }
  });
}

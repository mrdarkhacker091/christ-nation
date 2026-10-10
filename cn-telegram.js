/* Christ Nation – shared helper that sends website forms to Telegram
   through our own server function (/api/telegram). No bot token lives here. */
(function () {
  var API = '/api/telegram';
  var MAX_BYTES = 4 * 1024 * 1024;      // server limit per file
  var ALLOWED = ['image/jpeg', 'image/png', 'application/pdf'];

  function post(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok || !data || !data.ok) {
          throw new Error((data && data.error) || ('Request failed (' + r.status + ')'));
        }
        return data;
      });
    });
  }

  /* Shrink big phone photos so uploads are fast and fit the size limit. */
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read the image "' + file.name + '".')); };
      img.src = url;
    });
  }

  function prepareFile(file) {
    var type = (file.type || '').toLowerCase();
    if (ALLOWED.indexOf(type) === -1) {
      return Promise.reject(new Error('"' + file.name + '" must be a JPG, PNG or PDF file.'));
    }
    function finish(blob, name, mime) {
      if (blob.size > MAX_BYTES) {
        throw new Error('"' + file.name + '" is too large (max 4 MB). Please choose a smaller file.');
      }
      return { blob: blob, name: name, type: mime };
    }
    if (type === 'application/pdf') {
      return Promise.resolve().then(function () { return finish(file, file.name, type); });
    }
    return loadImage(file).then(function (img) {
      var longSide = Math.max(img.naturalWidth, img.naturalHeight);
      if (file.size <= 1.5 * 1024 * 1024 && longSide <= 2400) return finish(file, file.name, type);
      var scale = Math.min(1, 1800 / longSide);
      var c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return new Promise(function (resolve) {
        c.toBlob(function (b) {
          if (!b || b.size >= file.size) resolve(finish(file, file.name, type));
          else resolve(finish(b, file.name.replace(/\.[^.]+$/, '') + '.jpg', 'image/jpeg'));
        }, 'image/jpeg', 0.85);
      });
    });
  }

  window.CNTelegram = {
    prepareFile: prepareFile,

    /* payload: { icon, title, source, attachments, sections:[{icon,title,rows:[[label,value],...]}] }
       resolves to { ok, ref, message_id } */
    sendMessage: function (payload) {
      var body = JSON.parse(JSON.stringify(payload));
      return post(API + '?action=message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    },

    /* prepared = result of prepareFile(); opts = { ref, replyTo, label, who, asPhoto } */
    sendFile: function (prepared, opts) {
      opts = opts || {};
      var q = new URLSearchParams({
        action: 'file', ref: opts.ref || '', reply: opts.replyTo || '', label: opts.label || '',
        who: opts.who || '', name: prepared.name, mime: prepared.type, photo: opts.asPhoto ? '1' : '0'
      });
      return post(API + '?' + q.toString(), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: prepared.blob
      });
    }
  };
})();

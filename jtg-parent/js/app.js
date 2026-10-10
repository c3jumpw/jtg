/* Jump Tech Group — finder + contact form. No dependencies. */
(function () {
  'use strict';

  var BRANCHES = {
    f5: {
      name: 'Fortune 5 Agency', logo: 'f5.png', for: 'Scaling service businesses',
      offer: 'Marketing systems, operational workflows and lead generation, planned and implemented so the business can grow without everything running through you.',
      site: 'befortune5.com'
    },
    bms: {
      name: 'Build My Start-Up', logo: 'bms.png', for: 'Startups and new businesses',
      offer: 'Business setup, branding, website and marketing foundations, priced for early-stage budgets.',
      site: 'buildmystart-up.com'
    },
    blk: {
      name: 'Blanket Label', logo: 'blk.png', for: 'Consultants and professionals',
      offer: 'White-label design, branding and marketing you can resell to your clients under your own brand.'
    },
    bb: {
      name: 'Bar Boost', logo: 'bb.png', for: 'Restaurants, bars, clubs and lounges',
      offer: 'Lead generation, local marketing and customer acquisition systems built for food and nightlife.'
    },
    pd: {
      name: 'Party Designers', logo: 'pd.jpg', tile: 'pd', for: 'Event planners, and anyone planning an event',
      offer: 'The creative marketing arm for your event: invitations, flyers, slideshows, banners, backdrops, signage and event websites with guest photo uploads, turned around same-day or next-day.',
      site: 'wearepartydesigners.com'
    },
    blm: {
      name: 'Blloom', logo: 'blm.png', for: 'Beauty professionals',
      offer: 'Client acquisition, social growth, monetization and efficiency systems for beauty businesses.'
    },
    acad: {
      name: 'Acad Branding', logo: 'acad.png', tile: 'dark', for: 'Schools, academies, daycares and tutoring centers',
      offer: 'Branding, enrollment marketing and reworked processes that bring in more students.'
    },
    sd: {
      name: 'Seeder', logo: 'sd.png', for: 'Nonprofits and community organizations',
      offer: 'Brand, messaging and administrative systems that help you win grants, volunteers and community trust.'
    },
    bc: {
      name: 'BC Agency', logo: 'bc.png', tile: 'dark', for: 'Government contractors',
      offer: 'Website, branding and digital infrastructure built to government contracting standards.'
    },
    mbc: {
      name: 'Media BC', logo: 'mbc.png', for: 'Small and mid-sized businesses',
      offer: 'Video content from strategy through editing to posting, produced consistently.'
    },
    jw: {
      name: 'Jumpwebs', logo: 'jw.png', for: 'Businesses that need social handled',
      offer: 'Social content development, strategy, management and posting, done for you.'
    },
    f5ceo: {
      name: 'Fortune 5 CEO', logo: 'f5ceo.png', for: 'Entrepreneurs and growing business leaders',
      offer: 'A media network and community: leadership content, founder stories and member access.',
      site: 'fortune5ceo.com'
    }
  };

  // What each finder choice points to: the primary branch, an optional note, and branches often paired with it.
  var MATCHES = {
    retail: { branch: 'f5', note: 'Retail and ecommerce brands usually start here for marketing systems and steady lead flow.', pair: ['jw', 'mbc'] },
    service: { branch: 'f5', pair: ['jw', 'mbc'] },
    startup: { branch: 'bms', note: 'When the business is ready to scale, Fortune 5 Agency picks up where Build My Start-Up leaves off.', pair: ['f5', 'jw'] },
    hospitality: { branch: 'bb', pair: ['pd', 'jw'] },
    events: { branch: 'pd', pair: ['bb', 'mbc'] },
    beauty: { branch: 'blm', pair: ['mbc', 'jw'] },
    education: { branch: 'acad', pair: ['jw'] },
    nonprofit: { branch: 'sd', pair: ['mbc'] },
    gov: { branch: 'bc', pair: ['f5'] },
    consulting: { branch: 'blk', pair: ['f5ceo'] },
    video: { branch: 'mbc', pair: ['jw'] },
    social: { branch: 'jw', pair: ['mbc'] },
    whitelabel: { branch: 'blk', pair: ['f5'] },
    community: { branch: 'f5ceo', pair: ['f5'] },
    eventdesign: { branch: 'pd', note: 'For professional planners and for anyone planning an event themselves.', pair: ['mbc', 'bb'] }
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- Finder ---------- */
  var chips = document.querySelectorAll('.chip[data-match]');
  var result = document.getElementById('finder-result');

  function renderMatch(key) {
    var m = MATCHES[key];
    if (!m || !result) return;
    var b = BRANCHES[m.branch];

    var wrap = el('div', 'match');
    var tile = el('span', 'logo-tile match__logo' + (b.tile ? ' logo-tile--' + b.tile : ''));
    var img = el('img');
    img.src = '/assets/brands/' + b.logo;
    img.alt = '';
    tile.appendChild(img);
    wrap.appendChild(tile);
    wrap.appendChild(el('h3', 'match__name', b.name));
    wrap.appendChild(el('p', 'match__for', b.for));
    wrap.appendChild(el('p', 'match__offer', b.offer));
    if (m.note) wrap.appendChild(el('p', 'match__note', m.note));

    var actions = el('div', 'match__actions');
    var talk = el('a', 'btn btn--primary btn--small', 'Talk to ' + b.name);
    talk.href = '#contact';
    talk.setAttribute('data-branch', m.branch);
    actions.appendChild(talk);
    var details = el('a', 'link-quiet', 'More about ' + b.name);
    details.href = '#branch-' + m.branch;
    actions.appendChild(details);
    if (b.site) {
      var site = el('a', 'link-quiet', b.site);
      site.href = 'https://' + b.site;
      site.target = '_blank';
      site.rel = 'noopener';
      actions.appendChild(site);
    }
    wrap.appendChild(actions);

    if (m.pair && m.pair.length) {
      var pair = el('p', 'match__pair', 'Often paired with ');
      m.pair.forEach(function (k, i) {
        var a = el('a', null, BRANCHES[k].name);
        a.href = '#branch-' + k;
        pair.appendChild(a);
        if (i < m.pair.length - 2) pair.appendChild(document.createTextNode(', '));
        else if (i === m.pair.length - 2) pair.appendChild(document.createTextNode(' and '));
      });
      pair.appendChild(document.createTextNode('.'));
      wrap.appendChild(pair);
    }

    result.replaceChildren(wrap);

    // On phones the result sits below a long list of chips; bring it into view.
    var r = result.getBoundingClientRect();
    if (r.top > window.innerHeight - 120) {
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Scroll the window only; scrollIntoView would also scroll the clipped hero box.
      window.scrollTo({ top: r.top + window.scrollY - 88, behavior: reduce ? 'auto' : 'smooth' });
    }
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      chips.forEach(function (c) { c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
      renderMatch(chip.getAttribute('data-match'));
    });
  });

  /* ---------- "Talk to" / "Ask about" links pre-select the team ---------- */
  var branchSelect = document.getElementById('f-branch');
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[data-branch]');
    if (!link || !branchSelect) return;
    var key = link.getAttribute('data-branch');
    if (BRANCHES[key]) branchSelect.value = key;
    // Move focus into the form after the scroll so keyboard users land in the right place.
    setTimeout(function () {
      var name = document.getElementById('f-name');
      if (name) name.focus({ preventScroll: true });
    }, 450);
  });

  /* ---------- Contact form ---------- */
  var form = document.getElementById('contact-form');
  var status = document.getElementById('form-status');
  var submit = document.getElementById('form-submit');
  var submitLabel = submit ? (submit.querySelector('span') || submit) : null;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function setStatus(msg, isError) {
    status.textContent = msg || '';
    status.classList.toggle('form__status--error', !!isError);
  }

  function markInvalid(field, bad) {
    if (bad) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      // form.elements.namedItem, not form.name: HTMLFormElement.name is the form's own attribute.
      var f = function (n) { return form.elements.namedItem(n); };
      var fName = f('name'), fEmail = f('email'), fMessage = f('message');
      var data = {
        name: fName.value.trim(),
        email: fEmail.value.trim(),
        phone: f('phone').value.trim(),
        company: f('company').value.trim(),
        branch: f('branch').value,
        message: fMessage.value.trim(),
        website: f('website').value,
        page: location.href
      };

      var problems = [];
      markInvalid(fName, !data.name); if (!data.name) problems.push(fName);
      var badEmail = !EMAIL_RE.test(data.email);
      markInvalid(fEmail, badEmail); if (badEmail) problems.push(fEmail);
      markInvalid(fMessage, !data.message); if (!data.message) problems.push(fMessage);
      if (problems.length) {
        setStatus(!data.name ? 'Add your name so we know who to reply to.'
          : badEmail ? 'Check your email address. We reply by email.'
          : 'Add a short message about your business.', true);
        problems[0].focus();
        return;
      }

      submit.disabled = true;
      submitLabel.textContent = 'Sending…';
      setStatus('');

      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; });
        })
        .then(function (r) {
          if (!r.ok) throw new Error(r.body && r.body.error ? r.body.error : 'The message didn’t send. Try again in a moment.');
          var done = el('div', 'form-done');
          done.setAttribute('tabindex', '-1');
          done.appendChild(el('h3', null, 'Message sent'));
          done.appendChild(el('p', null, 'Thanks, ' + data.name.split(' ')[0] + '. We’ll reply to ' + data.email + ' once we’ve read it and matched you with the right team.'));
          form.replaceWith(done);
          done.focus();
        })
        .catch(function (err) {
          submit.disabled = false;
          submitLabel.textContent = 'Send message';
          setStatus(err && err.message && err.message !== 'Failed to fetch'
            ? err.message
            : 'The message didn’t send. Check your connection and try again.', true);
        });
    });
  }

  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();

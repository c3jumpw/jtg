/* ============================================================
   Brand Discovery — QUESTIONS
   Every question, option and line of host copy lives in this file.
   To change the conversation, edit here. No other file needs to
   know what is being asked.

   Field types
     text | email | tel | url   single-line input
     textarea                     multi-line input
     single                       tap one option (chips)
     multi                        tap several options (max optional)
     repeat                       rows of sub-fields with "add another"
     files                        upload area
     consent                      required checkbox

   Options can be a string or { v: 'Value', d: 'Short description' }.
   An option with other:true reveals a text box when picked.
   ============================================================ */

(function () {
  'use strict';

  function first(d) { return (d.firstName || '').trim() || 'there'; }
  function biz(d)   { return (d.businessName || '').trim() || 'your business'; }
  function clip(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1).trim() + '…' : s;
  }
  function pick(d, id) {
    // Resolve "Other" to whatever the person typed.
    var v = d[id];
    if (Array.isArray(v)) {
      return v.map(function (x) { return /^(other|something else)$/i.test(x) && d[id + 'Other'] ? d[id + 'Other'] : x; });
    }
    if (/^(other|something else)$/i.test(v || '') && d[id + 'Other']) return d[id + 'Other'];
    return v || '';
  }
  function list(arr, n) {
    arr = (arr || []).filter(Boolean);
    if (!arr.length) return '';
    var head = arr.slice(0, n).join(', ');
    return arr.length > n ? head + ' and ' + (arr.length - n) + ' more' : head;
  }

  window.F5_CHAPTERS = [
    { title: 'You & your business',  blurb: 'Who you are, your industry and your stage' },
    { title: 'What you offer',       blurb: 'Products, specialty, features and benefits' },
    { title: 'Who you serve',        blurb: 'Your best customers and why they choose you' },
    { title: 'Proof & direction',    blurb: 'Past wins, goals and the road ahead' },
    { title: 'Brand & contact',      blurb: 'Look and feel, your files, how to reach you' }
  ];

  window.F5_PAGES = [

    /* ---------- Chapter 1: You & your business ---------- */
    {
      id: 'hello', chapter: 1,
      host: function () { return 'Welcome. We’ll keep this relaxed, like a first coffee chat. What’s your name?'; },
      hint: 'We’ll ask for contact details at the end.',
      fields: [
        { id: 'firstName', type: 'text', half: true, label: 'First name', short: 'First name', required: true, autocomplete: 'given-name', max: 80,
          error: 'Add your first name so we know what to call you.' },
        { id: 'lastName', type: 'text', half: true, label: 'Last name', short: 'Last name', autocomplete: 'family-name', max: 80 },
        { id: 'role', type: 'single', label: 'Your role', short: 'Role', options: [
          'Founder or owner', 'Executive', 'Marketing or brand lead', 'Sales or operations lead', { v: 'Other', other: true }
        ] }
      ],
      echo: function (d) { return ((d.firstName || '') + ' ' + (d.lastName || '')).trim(); }
    },
    {
      id: 'business', chapter: 1,
      host: function (d) { return 'Good to meet you, ' + first(d) + '. What’s your business called?'; },
      fields: [
        { id: 'businessName', type: 'text', label: 'Business name', short: 'Business', required: true, autocomplete: 'organization', max: 160,
          error: 'Add the name of your business.' },
        { id: 'website', type: 'url', half: true, label: 'Website', short: 'Website', placeholder: 'yourbrand.com', autocomplete: 'url', max: 200,
          hint: 'No website yet? Leave it blank.' },
        { id: 'location', type: 'text', half: true, label: 'Where are you based?', short: 'Location', placeholder: 'City, state or country', autocomplete: 'address-level2', max: 120 }
      ],
      echo: function (d) { return d.businessName; }
    },
    {
      id: 'industry', chapter: 1, auto: true,
      host: function (d) { return 'Which of these is closest to what ' + biz(d) + ' does?'; },
      hint: 'Pick one. Choose Other if nothing fits.',
      fields: [
        { id: 'industry', type: 'single', label: 'Industry', short: 'Industry', options: [
          'Professional services', 'Home & trade services', 'Health & wellness', 'Real estate & construction',
          'Food & hospitality', 'Retail & e-commerce', 'Software & tech', 'Coaching & education',
          'Finance & insurance', 'Manufacturing & logistics', 'Nonprofit', 'Creative & media', { v: 'Other', other: true }
        ] }
      ],
      echo: function (d) { return pick(d, 'industry'); }
    },
    {
      id: 'stage', chapter: 1, auto: true,
      host: function (d) { return 'Where would you say ' + biz(d) + ' is right now?'; },
      hint: 'Be honest. There’s no wrong answer, and it helps us start in the right place.',
      fields: [
        { id: 'stage', type: 'single', layout: 'list', label: 'Current stage', short: 'Stage', options: [
          { v: 'Just an idea',  d: 'Pre-launch, still shaping it' },
          { v: 'Early days',    d: 'Launched and landing the first customers' },
          { v: 'Growing',       d: 'Steady customers, but growth is uneven' },
          { v: 'Established',   d: 'Solid revenue and ready to scale' },
          { v: 'Reinventing',   d: 'A rebrand, a pivot or a new chapter' }
        ] }
      ],
      echo: function (d) { return d.stage; }
    },

    /* ---------- Chapter 2: What you offer ---------- */
    {
      id: 'model', chapter: 2,
      host: function () { return 'A few quick taps about how the business runs.'; },
      fields: [
        { id: 'businessModel', type: 'multi', label: 'How does the money come in? Pick all that apply.', short: 'Business model', options: [
          'Selling to businesses (B2B)', 'Selling to consumers (B2C)', 'Subscriptions or memberships',
          'One-time projects or sales', 'Monthly retainers', 'Physical products',
          'Digital products or software', 'Franchise or licensing', 'Marketplace or commissions'
        ] },
        { id: 'teamSize', type: 'single', label: 'How big is the team?', short: 'Team size', compact: true, options: [
          'Just me', '2 to 5', '6 to 20', '21 to 50', '51 or more'
        ] },
        { id: 'revenue', type: 'single', label: 'Roughly what does the business bring in each year?', short: 'Annual revenue', compact: true,
          hint: 'Optional. It helps us size our recommendations.', options: [
          'Under $100K', '$100K to $500K', '$500K to $1M', '$1M to $5M', '$5M or more', 'Prefer not to say'
        ] }
      ],
      echo: function (d) { return list(d.businessModel, 2); }
    },
    {
      id: 'offer', chapter: 2,
      host: function (d) { return 'What are the main things ' + biz(d) + ' sells or provides?'; },
      fields: [
        { id: 'offer', type: 'textarea', rows: 4, label: 'Products and services', short: 'Main products and services', max: 2000,
          hint: 'List them, most important first.' },
        { id: 'specialty', type: 'textarea', rows: 3, label: 'Your specialty', short: 'Main specialty', max: 1500,
          hint: 'What are you best at? What would you stake your name on?' }
      ],
      echo: function (d) { return clip(d.offer, 70); }
    },
    {
      id: 'features', chapter: 2,
      host: function () { return 'Let’s get specific. What are your top features, and what does each one do for the customer?'; },
      hint: 'Example: “Same-day booking” means customers never wait a week for help.',
      fields: [
        { id: 'features', type: 'repeat', label: 'Features and benefits', short: 'Features and benefits', min: 3, max: 6, addLabel: 'Add another feature',
          sub: [
            { id: 'feature', label: 'Feature', placeholder: 'What it is', max: 160 },
            { id: 'benefit', label: 'Benefit', placeholder: 'What the customer gets', max: 240 }
          ] }
      ],
      echo: function (d) {
        var n = (d.features || []).filter(function (r) { return (r.feature || r.benefit || '').trim(); }).length;
        return n ? n + (n === 1 ? ' feature noted' : ' features noted') : '';
      }
    },

    /* ---------- Chapter 3: Who you serve ---------- */
    {
      id: 'audience', chapter: 3,
      host: function () { return 'Now the people. Who do you serve best?'; },
      fields: [
        { id: 'audienceType', type: 'multi', label: 'Who are your customers? Pick all that apply.', short: 'Customer types', options: [
          'Individuals & families', 'Small businesses', 'Mid-size companies', 'Large enterprises',
          'Government & public sector', 'Nonprofits', { v: 'Other', other: true }
        ] },
        { id: 'idealClient', type: 'textarea', rows: 4, label: 'Your best-fit customer', short: 'Best-fit customer', max: 2000,
          hint: 'Who they are, what they’re dealing with, and why they come to you.' }
      ],
      echo: function (d) { return list(pick(d, 'audienceType'), 2); }
    },
    {
      id: 'whyyou', chapter: 3,
      host: function () { return 'What problem do you solve, and why do people pick you?'; },
      fields: [
        { id: 'problem', type: 'textarea', rows: 3, label: 'The problem you solve', short: 'Problem solved', max: 1500 },
        { id: 'proposition', type: 'textarea', rows: 3, label: 'Why customers choose you', short: 'Value proposition', max: 1500,
          hint: 'Your value proposition, in a sentence or two.' },
        { id: 'competitors', type: 'textarea', rows: 2, label: 'Who else do they consider?', short: 'Competitors and alternatives', max: 800,
          hint: 'Competitors or alternatives. Names or websites.' }
      ],
      echo: function (d) { return clip(d.problem || d.proposition, 70); }
    },

    /* ---------- Chapter 4: Proof & direction ---------- */
    {
      id: 'proof', chapter: 4,
      host: function () { return 'Tell us about a win. What’s a client result you’re proud of?'; },
      hint: 'Add up to three. Real numbers make the best stories.',
      fields: [
        { id: 'wins', type: 'repeat', label: 'Past client success', short: 'Client wins', min: 1, max: 3, addLabel: 'Add another win',
          sub: [
            { id: 'client', label: 'Client or type of client', placeholder: 'Who was it for?', max: 160, wide: true },
            { id: 'work', label: 'What you did', type: 'textarea', rows: 2, max: 600, wide: true },
            { id: 'result', label: 'The result', type: 'textarea', rows: 2, placeholder: 'Numbers are welcome', max: 600, wide: true }
          ] },
        { id: 'testimonial', type: 'textarea', rows: 3, label: 'A customer quote we can use', short: 'Customer quote', max: 1200,
          hint: 'Optional. A line from a happy customer, in their words.' }
      ],
      echo: function (d) {
        var w = (d.wins || []).filter(function (r) { return (r.client || r.work || r.result || '').trim(); }).length;
        return w ? w + (w === 1 ? ' client win shared' : ' client wins shared') : '';
      }
    },
    {
      id: 'goals', chapter: 4,
      host: function (d) { return 'Where do you want to take ' + biz(d) + '? Pick your top priorities for the next 12 months.'; },
      fields: [
        { id: 'goals', type: 'multi', max: 3, label: 'Top priorities', short: 'Goals for the next 12 months', options: [
          'Get more leads', 'Raise prices or margins', 'Refresh the brand', 'Launch a new website',
          'Launch a new product or service', 'Build better systems', 'Enter a new market', 'Grow the team',
          'Prepare to sell or raise money', { v: 'Something else', other: true }
        ] }
      ],
      echo: function (d) { return list(pick(d, 'goals'), 2); }
    },
    {
      id: 'vision', chapter: 4,
      host: function () { return 'And the bigger picture?'; },
      fields: [
        { id: 'vision', type: 'textarea', rows: 4, label: 'Three years from now', short: 'Three-year vision', max: 2000,
          hint: 'Picture the business in three years. What does it look like?' },
        { id: 'obstacle', type: 'single', compact: true, label: 'What’s holding you back most today?', short: 'Biggest obstacle', options: [
          'Not enough leads', 'An unclear message', 'Inconsistent delivery', 'Not enough time', 'Budget', 'Team or hiring', 'Not sure yet'
        ] },
        { id: 'timeline', type: 'single', compact: true, label: 'When would you like to get started?', short: 'Timeline', options: [
          'Right away', 'Within a month', 'In 1 to 3 months', 'Just exploring'
        ] }
      ],
      echo: function (d) { return clip(d.vision, 70); }
    },

    /* ---------- Chapter 5: Brand & contact ---------- */
    {
      id: 'brand', chapter: 5,
      host: function () { return 'Let’s talk look and feel.'; },
      fields: [
        { id: 'brandWords', type: 'multi', max: 4, label: 'Which words fit your brand, or the brand you want? Pick up to 4.', short: 'Brand personality', options: [
          'Bold', 'Trusted', 'Premium', 'Friendly', 'Modern', 'Expert',
          'Playful', 'Down-to-earth', 'Innovative', 'Established', 'Minimal', 'Energetic'
        ] },
        { id: 'brandStatus', type: 'single', compact: true, label: 'Where do your brand assets stand?', short: 'Brand assets today', options: [
          'A full brand guide', 'Logo and colors', 'Just a logo', 'Nothing yet', 'It needs a refresh'
        ] },
        { id: 'admired', type: 'textarea', rows: 2, label: 'Brands you admire', short: 'Brands they admire', max: 800,
          hint: 'Names or websites, and what you like about them.' }
      ],
      echo: function (d) { return list(pick(d, 'brandWords'), 3); }
    },
    {
      id: 'files', chapter: 5,
      host: function () { return 'Have a logo or materials? Send them over.'; },
      hint: 'Anything that shows us how you present today. Skip this if you don’t have them handy.',
      fields: [
        { id: 'logos', type: 'files', label: 'Logos and brand files', short: 'Logo files',
          hint: 'Logo files, color palettes, fonts or a brand guide.' },
        { id: 'materials', type: 'files', label: 'Other materials', short: 'Other materials',
          hint: 'Decks, brochures, product sheets, photos or past campaigns.' }
      ],
      echo: function (d, files) {
        var n = ((files && files.logos) || []).length + ((files && files.materials) || []).length;
        return n ? n + (n === 1 ? ' file attached' : ' files attached') : '';
      }
    },
    {
      id: 'contact', chapter: 5, last: true,
      host: function (d) { return 'Last step, ' + first(d) + '. How do we reach you?'; },
      fields: [
        { id: 'email', type: 'email', half: true, label: 'Email', short: 'Email', required: true, autocomplete: 'email', max: 200,
          error: 'Add the email address where we can reach you.' },
        { id: 'phone', type: 'tel', half: true, label: 'Phone', short: 'Phone', autocomplete: 'tel', max: 40, hint: 'Optional.' },
        { id: 'contactPref', type: 'single', compact: true, label: 'How would you like us to reach out?', short: 'Preferred contact', options: [
          'Email', 'Phone call', 'Text message', 'Video call'
        ] },
        { id: 'heardFrom', type: 'single', compact: true, label: 'How did you hear about us?', short: 'Heard about us', options: [
          'Referral', 'Search', 'Social media', 'An event', { v: 'Other', other: true }
        ] },
        { id: 'notes', type: 'textarea', rows: 3, label: 'Anything else we should know?', short: 'Notes', max: 2000 },
        { id: 'consent', type: 'consent', required: true,
          label: 'It’s fine for The Fortune 5 Agency to contact me about these answers.',
          error: 'Please tick the box so we know we can follow up.' }
      ],
      echo: null
    }
  ];
})();

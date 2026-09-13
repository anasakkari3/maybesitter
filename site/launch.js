(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const form = $('#signup-form');
  const sourceRaw = new URLSearchParams(location.search).get('source') || 'direct';
  const source = /^[a-zA-Z0-9_-]{1,64}$/.test(sourceRaw) ? sourceRaw.toLowerCase() : 'direct';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let pending = false, registered = false, started = false;
  const metricsAllowed = navigator.doNotTrack !== '1' && navigator.globalPrivacyControl !== true;
  function track(event) {
    if (!metricsAllowed) return;
    fetch('/api/early-access/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, source }), keepalive: true }).catch(() => {});
  }
  track('page_view');
  document.querySelectorAll('[data-cta]').forEach(link => link.addEventListener('click', () => track('early_access_click')));
  form.addEventListener('focusin', () => { if (!started) { started = true; track('registration_started'); } });
  function showErrors(errors) {
    ['name', 'email', 'device', 'phone'].forEach(name => {
      $(`#${name}-error`).textContent = errors[name] || '';
      form.querySelectorAll(`[name="${name}"]`).forEach(input => { input.setAttribute('aria-invalid', String(Boolean(errors[name]))); if (name === 'device') input.setAttribute('aria-describedby', 'device-error'); });
    });
  }
  form.addEventListener('input', event => {
    const name = event.target.name;
    if ($(`#${name}-error`)) { $(`#${name}-error`).textContent = ''; event.target.setAttribute('aria-invalid', 'false'); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || registered) return;
    const body = Object.fromEntries(new FormData(form)); body.source = source;
    const errors = {};
    if (!body.name?.trim() || body.name.trim().length > 80 || /[\p{Cc}\p{Cf}<>]/u.test(body.name)) errors.name = 'Please enter your first name.';
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test((body.email || '').trim()) || body.email.length > 254) errors.email = 'Please enter a valid email address.';
    if (!['iphone', 'android'].includes(body.device)) errors.device = 'Please choose iPhone or Android.';
    if (body.phone?.trim() && (!/^\+?[\d\s().-]{7,30}$/.test(body.phone.trim()) || body.phone.replace(/\D/g, '').length < 7 || body.phone.replace(/\D/g, '').length > 15)) errors.phone = 'Please enter a valid phone number, or leave it blank.';
    showErrors(errors); $('#form-error').hidden = true;
    if (Object.keys(errors).length) { form.querySelector(`[name="${Object.keys(errors)[0]}"]`).focus(); return; }
    pending = true; form.querySelector('button[type="submit"]').disabled = true; form.setAttribute('aria-busy', 'true'); $('#submit-label').textContent = 'Saving your place…';
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const result = await fetch('/api/early-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      const data = await result.json().catch(() => ({}));
      if (!result.ok || data.ok !== true) { if (data.fields) showErrors(data.fields); throw new Error(data.error || 'We couldn’t save your place. Please try again.'); }
      registered = true; $('#signup-content').hidden = true; $('#signup-success').hidden = false; $('#signup-success').focus();
      if (!reducedMotion.matches && window.gsap) gsap.fromTo('#signup-success', { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: .5 });
      lenis?.resize();
    } catch (error) {
      $('#form-error').textContent = error.name === 'AbortError' ? 'This is taking longer than expected. Please try again—your place won’t be added twice.' : error instanceof TypeError ? 'You appear to be offline. Check your connection and try again.' : error.message;
      $('#form-error').hidden = false;
    } finally { clearTimeout(timeout); pending = false; form.setAttribute('aria-busy', 'false'); form.querySelector('button[type="submit"]').disabled = false; $('#submit-label').textContent = 'Get Early Access'; }
  });

  const screens = {
    today: ['product-today-en.png', 'MaybeSitter Today screen showing commitments and a next-step suggestion in English'],
    calendar: ['product-calendar-en.png', 'MaybeSitter weekly calendar screen showing commitments in English'],
    'first-move': ['product-first-move-en.png', 'MaybeSitter first-step screen proposing five study sessions, with explicit accept and edit controls in English'],
  };
  document.querySelectorAll('[data-screen]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-screen]').forEach(item => { const active = item === button; item.classList.toggle('is-active', active); item.setAttribute('aria-pressed', String(active)); });
    const [file, alt] = screens[button.dataset.screen]; const screen = $('#product-screen'); screen.src = `/assets/${file}`; screen.alt = alt;
    if (window.gsap && !reducedMotion.matches) gsap.fromTo(screen, { opacity: .3, y: 8 }, { opacity: 1, y: 0, duration: .35, overwrite: true });
  }));

  const dialog = $('#privacy-dialog'); let privacyOpener;
  document.querySelectorAll('.privacy-trigger').forEach(button => button.addEventListener('click', () => { privacyOpener = button; dialog.showModal(); lenis?.stop(); }));
  $('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => { lenis?.start(); privacyOpener?.focus(); });
  const sticky = $('.mobile-cta');
  new IntersectionObserver(entries => { sticky.classList.toggle('is-hidden', entries[0].isIntersecting); }, { threshold: .05 }).observe($('#early-access'));

  // Enhancement only: all content and controls work if either motion library fails.
  let lenis = null;
  if (window.gsap && window.ScrollTrigger) {
    gsap.registerPlugin(ScrollTrigger);
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      // Preserve native touch scrolling; wheel motion and ScrollTrigger share one clock.
      if (window.Lenis && matchMedia('(pointer: fine)').matches) {
        lenis = new Lenis({ duration: .9, smoothWheel: true, syncTouch: false, anchors: true });
        lenis.on('scroll', ScrollTrigger.update);
      }
      const tick = time => lenis?.raf(time * 1000); gsap.ticker.add(tick); gsap.ticker.lagSmoothing(0);
      gsap.fromTo('.launch-hero__copy > *', { y: 20, opacity: 0 }, { y: 0, opacity: 1, stagger: .07, duration: .7, ease: 'power2.out', clearProps: 'transform,opacity' });
      gsap.fromTo('.launch-phone', { y: 25, rotation: -8, opacity: 0 }, { y: 0, rotation: -5, opacity: 1, duration: 1, ease: 'power2.out' });
      gsap.to('.launch-phone', { y: -24, rotation: 0, ease: 'none', scrollTrigger: { trigger: '.launch-hero', start: 'top top', end: 'bottom top', scrub: 1 } });
      document.querySelectorAll('.section-heading,.flow-row,.flow-answer,.adapt-copy,.access-copy').forEach(el => gsap.fromTo(el, { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: .65, ease: 'power2.out', scrollTrigger: { trigger: el, start: 'top 93%', once: true }, clearProps: 'transform,opacity' }));
      const cards = gsap.timeline({ scrollTrigger: { trigger: '.context-stage', start: 'top 85%', end: 'bottom 60%', scrub: 1 } });
      cards.from('.context-card--one', { x: -25, y: -10, rotation: -18 }, 0).from('.context-card--two', { x: 25, rotation: 20 }, 0).from('.context-card--three', { y: 30, rotation: -12 }, 0).from('.context-resolution', { y: 30, opacity: .2 }, .2);
      gsap.from('.day-line .next-step', { y: 14, opacity: .3, scrollTrigger: { trigger: '.adapt-section', start: 'top 80%', end: 'center center', scrub: 1 } });
      document.fonts.ready.then(() => ScrollTrigger.refresh());
      return () => { gsap.ticker.remove(tick); lenis?.destroy(); lenis = null; };
    });
  }
})();

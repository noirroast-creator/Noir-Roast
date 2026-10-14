// Product photo slider: arrows on the image, dots, keyboard and swipe. Works on any [data-slider].
(() => {
  const init = (slider) => {
    const track = slider.querySelector('.slider-track');
    const slides = [...slider.querySelectorAll('.slide')];
    const prev = slider.querySelector('.slider-prev');
    const next = slider.querySelector('.slider-next');
    const dotsBox = slider.querySelector('.slider-dots');
    const status = slider.querySelector('[data-slider-status]');
    if (slides.length < 2) return;
    let index = 0;
    let loaded = false;
    let startX = null;

    // The other photos load only when the card is near the screen (or the first time someone uses an arrow).
    const loadAll = () => {
      if (loaded) return;
      loaded = true;
      slider.querySelectorAll('img[data-src]').forEach((img) => { img.src = img.dataset.src; img.removeAttribute('data-src'); });
    };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { loadAll(); io.disconnect(); } }, { rootMargin: '400px' });
      io.observe(slider);
    } else loadAll();

    const dots = slides.map((_, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'slider-dot';
      dot.setAttribute('aria-label', `Show photo ${i + 1}`);
      dot.addEventListener('click', () => show(i));
      dotsBox.append(dot);
      return dot;
    });

    const show = (i) => {
      loadAll();
      index = (i + slides.length) % slides.length;
      track.style.transform = `translateX(${-index * 100}%)`;
      slides.forEach((slide, n) => {
        slide.setAttribute('role', 'group');
        slide.setAttribute('aria-roledescription', 'slide');
        slide.setAttribute('aria-label', `${n + 1} of ${slides.length}`);
        slide.setAttribute('aria-hidden', n === index ? 'false' : 'true');
      });
      dots.forEach((dot, n) => { dot.classList.toggle('is-active', n === index); dot.setAttribute('aria-current', n === index ? 'true' : 'false'); });
      if (status) status.textContent = `Photo ${index + 1} of ${slides.length}`;
    };

    prev.addEventListener('click', () => show(index - 1));
    next.addEventListener('click', () => show(index + 1));
    slider.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); show(index - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); show(index + 1); }
    });
    slider.addEventListener('touchstart', (event) => { startX = event.changedTouches[0].clientX; }, { passive: true });
    slider.addEventListener('touchend', (event) => {
      if (startX == null) return;
      const dx = event.changedTouches[0].clientX - startX;
      startX = null;
      if (Math.abs(dx) > 40) show(dx < 0 ? index + 1 : index - 1);
    }, { passive: true });

    prev.hidden = false;
    next.hidden = false;
    dotsBox.hidden = false;
    show(0);
  };
  document.querySelectorAll('[data-slider]').forEach(init);
})();
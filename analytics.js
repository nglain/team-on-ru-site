(function initTeamOnAnalytics(window, document) {
  const counterId = 107062766;

  window.ym = window.ym || function queueMetrikaCall() {
    (window.ym.a = window.ym.a || []).push(arguments);
  };
  window.ym.l = Number(new Date());

  const tagUrl = `https://mc.yandex.ru/metrika/tag.js?id=${counterId}`;
  const isLoaded = Array.from(document.scripts).some((script) => script.src === tagUrl);

  if (!isLoaded) {
    const tag = document.createElement('script');
    const firstScript = document.getElementsByTagName('script')[0];
    tag.async = true;
    tag.src = tagUrl;
    firstScript.parentNode.insertBefore(tag, firstScript);
  }

  window.ym(counterId, 'init', {
    ssr: true,
    webvisor: true,
    clickmap: true,
    referrer: document.referrer,
    url: window.location.href,
    accurateTrackBounce: true,
    trackLinks: true,
  });

  window.TeamONAnalytics = Object.freeze({
    counterId,
    goal(name) {
      if (!name || typeof window.ym !== 'function') return false;
      window.ym(counterId, 'reachGoal', name);
      return true;
    },
  });
})(window, document);

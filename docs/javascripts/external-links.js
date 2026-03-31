// Open external links in new tabs
document.addEventListener('DOMContentLoaded', function() {
  var links = document.querySelectorAll('a[href^="http"]');
  links.forEach(function(link) {
    if (!link.href.includes(window.location.hostname)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  });

  // Make the header site title a link to the home page
  var logoLink = document.querySelector('.md-header__button.md-logo');
  var titleEl = document.querySelector('.md-header__title');
  if (titleEl && logoLink && !titleEl.closest('a')) {
    var homeHref = logoLink.getAttribute('href') || '.';
    titleEl.style.cursor = 'pointer';
    titleEl.addEventListener('click', function() {
      window.location.href = homeHref;
    });
  }
});

var semantic = {
  _requestId: 0,
  _apiUrl: 'http://localhost:8001',
  _semester: '',

  load: function() {
    this._semester = (typeof semesters !== 'undefined' && semesters.length) ? semesters[0] : '';
    $('#search').keydown(function(e) {
      if (e.shiftKey && (e.key === 'Enter' || e.keyCode === 13)) {
        e.preventDefault();
        semantic.run($('#search').val());
      }
    });
  },

  run: function(query) {
    query = (query || '').trim();
    if (!query) {
      $('#content #dynamiccontent').html('');
      $('#content #defaultcontent').show();
      return;
    }

    window.scrollTo(0, 0);
    $('#content #defaultcontent').hide();
    $('#content #dynamiccontent').html('<p id="footer">Searching...</p>');

    var requestId = ++this._requestId;
    var self = this;
    fetch(this._apiUrl + '/search/semantic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query,
        semester: this._semester,
        limit: 25
      })
    }).then(function(response) {
      if (!response.ok) {
        return response.text().then(function(text) {
          var detail = text;
          try {
            var parsed = JSON.parse(text);
            if (parsed && parsed.detail) {
              detail = typeof parsed.detail === 'string'
                ? parsed.detail
                : JSON.stringify(parsed.detail);
            }
          } catch (err) {}
          throw new Error('HTTP ' + response.status + ': ' + detail);
        });
      }
      return response.json();
    }).then(function(body) {
      if (requestId !== self._requestId) return;
      self._renderResults(body.results || []);
    }).catch(function(error) {
      if (requestId !== self._requestId) return;
      $('#content #dynamiccontent').html(
        '<p class="semantic-error">Semantic search failed. ' +
        'Ensure Docker Qdrant and the API are running (./run.sh). ' +
        textToHTML(String(error.message || error)) +
        '</p>'
      );
    });
  },

  _courseByName: function(name) {
    for (var i = 0; i < courses.length; i++) {
      if (courses[i].name === name) return courses[i];
    }
    return null;
  },

  _renderResults: function(results) {
    var matches = [];
    for (var i = 0; i < results.length; i++) {
      var hit = results[i];
      var course = this._courseByName(hit.course_name);
      if (!course) continue;
      if (options.shouldHideCoursesWithoutSections) {
        var hasSections = false;
        for (var semester in course.sections) {
          hasSections = true;
          break;
        }
        if (!hasSections) continue;
      }
      matches.push({ course: course, score: hit.score || 0 });
    }

    search.clearHighlight();
    search.renderMatches(matches, matches.length, 'semantic result');
  }
};

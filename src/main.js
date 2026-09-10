// a map of CRNs to { course, section } objects
var crnMap = {};
var semester_codes = typeof semester_codes != 'undefined' ? semester_codes : {};
var semesters = typeof semesters != 'undefined' ? semesters : [];
var courses = typeof courses != 'undefined' ? courses : [];

// how many different colors before we need to wrap back around
var colorCount = 21;

function formatTimeValue(value) {
  if (!value) return value;
  value = value.replace(/^[\s-]+|[\s-]+$/g, '');
  if (!value || value.toLowerCase() == 'tba') return value;
  var digits = value.replace(/[^0-9]/g, '');
  if (digits.length != 4) return value;

  var hours = parseInt(digits.substring(0, 2), 10);
  var minutes = digits.substring(2);
  var suffix = 'am';
  if (hours == 0) {
    hours = 12;
  } else if (hours == 12) {
    suffix = 'pm';
  } else if (hours > 12) {
    hours -= 12;
    suffix = 'pm';
  }
  return hours + ':' + minutes + suffix;
}

function formatTimeRange(value) {
  if (!value) return value;
  var parts = value.split('-');
  if (parts.length != 2) return formatTimeValue(value);
  return formatTimeValue(parts[0]) + ' - ' + formatTimeValue(parts[1]);
}

function sectionTypeLabel(courseType) {
  courseType = courseType || '';
  var labels = {
    'LEC': 'Class',
    'LAB': 'Lab',
    'SEM': 'Seminar',
    'DIS': 'Discussion',
    'IND': 'Independent Study'
  };
  return (courseType in labels) ? labels[courseType] : courseType;
}

function chooseCourseTitle(rows, courseSubject, courseNumber) {
  var titleCounts = {};
  var uniqueTitles = [];
  for (var i = 0; i < rows.length; i++) {
    var title = rows[i].courseTitle || '';
    if (!title) continue;
    if (!(title in titleCounts)) {
      titleCounts[title] = 0;
      uniqueTitles.push(title);
    }
    titleCounts[title]++;
  }

  var bestTitle = '';
  var bestCount = 0;
  for (var title in titleCounts) {
    if (titleCounts[title] > bestCount) {
      bestTitle = title;
      bestCount = titleCounts[title];
    }
  }

  if (bestCount > 1 && bestCount >= Math.ceil(rows.length / 2))
    return bestTitle;
  if (uniqueTitles.length == 1)
    return uniqueTitles[0];
  if (rows.length > 1 && uniqueTitles.length > 1)
    return courseSubject;
  return bestTitle || courseSubject;
}

function buildCourseObjectsFromScrapeData(data) {
  semester_codes = {};
  semesters = [];
  courses = [];

  if (!data) return;

  semester_codes[data.term_name] = data.term_code;
  semesters.push(data.term_name);

  var groupedRows = {};
  for (var i = 0; i < data.rows.length; i++) {
    var row = data.rows[i];
    var courseName = row.courseSubject + ' ' + row.courseNumber;
    if (!(courseName in groupedRows)) groupedRows[courseName] = [];
    groupedRows[courseName].push(row);
  }

  var courseNames = [];
  for (var courseName in groupedRows)
    courseNames.push(courseName);
  courseNames.sort();

  for (var j = 0; j < courseNames.length; j++) {
    var name = courseNames[j];
    var rows = groupedRows[name];
    var firstRow = rows[0];
    var title = chooseCourseTitle(rows, firstRow.courseSubject, firstRow.courseNumber);
    var course = {
      name: name,
      title: title,
      description: '',
      attributes: '',
      sections: {}
    };

    var attributes = [];
    if (firstRow.credits) attributes.push(firstRow.credits + ' credits');
    if (firstRow.campus) attributes.push(firstRow.campus);
    if (firstRow.college) attributes.push(firstRow.college);
    if (firstRow.department) attributes.push(firstRow.department);
    course.attributes = attributes.join(', ');
    course.sections[data.term_name] = {};

    for (var k = 0; k < rows.length; k++) {
      var row = rows[k];
      var sectionType = sectionTypeLabel(row.courseType);
      var section = {
        crn: parseInt(row.providedCrn || row.syntheticCrn, 10),
        schedule_type: row.courseType || '',
        available: row.available || '',
        meetings: [{
          instructors: row.instructor || '',
          days: row.days || '',
          time: formatTimeRange(row.time || ''),
          where: row.locations || ''
        }]
      };

      if (row.courseTitle && row.courseTitle != course.title)
        section.special_title = row.courseTitle;

      if (!(sectionType in course.sections[data.term_name]))
        course.sections[data.term_name][sectionType] = [];
      course.sections[data.term_name][sectionType].push(section);
    }

    courses.push(course);
  }
}

function textToHTML(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>').replace('"', '&quot;').replace('\'', '&#39;');
}

function setCookie(name, value) {
  // attempt to use localStorage first because 'file://' urls don't work with cookies
  if (typeof(localStorage) != 'undefined') {
    localStorage[name] = value;
  } else {
    var date = new Date();
    date.setTime(date.getTime() + 5*365*24*60*60*1000);
    document.cookie = name + '=' + value + '; expires=' + date.toGMTString() + '; path=/';
  }
}

function getCookie(name) {
  // attempt to use localStorage first because 'file://' urls don't work with cookies
  if (typeof(localStorage) != 'undefined') {
    return (name in localStorage ? localStorage[name] : '');
  } else {
    var pairs = document.cookie.split(';');
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i], equals = pair.indexOf('=');
      if (equals != -1 && pair.substring(0, equals).replace(/ /g, '') == name)
        return pair.substring(equals + 1);
    }
    return '';
  }
}

// initialize the components
window.onload = function() {
  if (typeof popScrapeData != 'undefined') {
    buildCourseObjectsFromScrapeData(popScrapeData);
  }

  // create a map from CRN to course and section, and add semesters and types to all sections
  for (var i = 0; i < courses.length; i++) {
    var course = courses[i];
    for (var semester in course.sections) {
      for (var sectionType in course.sections[semester]) {
        var sections = course.sections[semester][sectionType];
        for (var j = 0; j < sections.length; j++) {
          var section = sections[j];
          section.type = sectionType;
          section.semester = semester;
          crnMap[section.crn] = { 'section': section, 'course': course };
        }
      }
    }
  }

  cart.load();
  schedule.load();
  options.load();
  search.load();

  // preload the notification image
  var img = new Image;
  img.style.display = 'none';
  img.src = 'notify.png';
  document.body.appendChild(img);
};

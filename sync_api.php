<?php
/**
 * AJAX endpoint for auto-sync after settings save.
 * Called by JavaScript from the settings page or by the backend API.
 *
 * Auth modes:
 *   1. Moodle admin session (normal UI save)
 *   2. POST with { "secret": "<api_secret>" } (programmatic trigger)
 */

require_once(__DIR__ . '/../../../../config.php');

header('Content-Type: application/json');

$server = (string) get_config('quizaccess_exammonitor', 'sync_server');
$secret = (string) get_config('quizaccess_exammonitor', 'sync_secret');

if ($server === '' || $secret === '') {
    echo json_encode(['ok' => false, 'error' => 'Server or key not configured']);
    exit;
}

// Auth mode 2: secret-based (programmatic trigger from backend)
$jsonBody = json_decode(file_get_contents('php://input'), true);
$isSecretAuth = false;
if (is_array($jsonBody) && isset($jsonBody['secret']) && hash_equals($secret, (string)$jsonBody['secret'])) {
    $isSecretAuth = true;
}

// Auth mode 1: Moodle admin session
if (!$isSecretAuth) {
    require_login();
    if (!has_capability('moodle/site:config', context_system::instance())) {
        echo json_encode(['ok' => false, 'error' => 'Not admin']);
        exit;
    }
}

global $DB, $CFG;

// 1. Courses
$rows = $DB->get_records_sql("SELECT id, fullname FROM {course} WHERE id > 1 ORDER BY id");
$courses = [];
foreach ($rows as $r) {
    $courses[] = ['id' => (int)$r->id, 'fullname' => (string)$r->fullname];
}

// 2. Teachers
$rows = $DB->get_records_sql(
    "SELECT DISTINCT u.id, u.username, u.firstname, u.lastname
       FROM {role_assignments} ra
       JOIN {context} c ON c.id = ra.contextid
       JOIN {role} r ON r.id = ra.roleid
       JOIN {user} u ON u.id = ra.userid
      WHERE c.contextlevel = " . CONTEXT_COURSE . "
        AND r.archetype IN ('teacher','editingteacher') AND u.deleted = 0
      ORDER BY u.id"
);
$teachers = [];
foreach ($rows as $r) {
    $teachers[] = [
        'id' => (int)$r->id,
        'username' => (string)$r->username,
        'fullname' => trim((string)$r->firstname . ' ' . (string)$r->lastname),
    ];
}

// 3. Students
$rows = $DB->get_records_sql(
    "SELECT DISTINCT u.id, u.username, u.firstname, u.lastname
       FROM {role_assignments} ra
       JOIN {context} c ON c.id = ra.contextid
       JOIN {role} r ON r.id = ra.roleid
       JOIN {user} u ON u.id = ra.userid
      WHERE c.contextlevel = " . CONTEXT_COURSE . "
        AND r.archetype = 'student' AND u.deleted = 0
      ORDER BY u.id"
);
$students = [];
foreach ($rows as $r) {
    $students[] = [
        'id' => (int)$r->id,
        'username' => (string)$r->username,
        'fullname' => trim((string)$r->firstname . ' ' . (string)$r->lastname),
    ];
}

// 4. Quizzes
$rows = $DB->get_records_sql(
    "SELECT q.id, q.name, q.course, q.timelimit, cm.id AS cmid
       FROM {quiz} q
       JOIN {course_modules} cm ON cm.instance = q.id AND cm.module = (
           SELECT id FROM {modules} WHERE name = 'quiz' LIMIT 1
       )
       ORDER BY q.id"
);
$quizzes = [];
foreach ($rows as $r) {
    $quizzes[] = [
        'id' => (int)$r->id,
        'name' => (string)$r->name,
        'course' => (int)$r->course,
        'cmid' => (int)$r->cmid,
        'duration_minutes' => (int)($r->timelimit > 0 ? round($r->timelimit / 60) : 0),
    ];
}

// 5. Enrollments
$rs = $DB->get_recordset_sql(
    "SELECT DISTINCT ra.userid, c.instanceid AS courseid, u.firstname, u.lastname
       FROM {role_assignments} ra
       JOIN {context} c ON c.id = ra.contextid
       JOIN {role} r ON r.id = ra.roleid
       JOIN {user} u ON u.id = ra.userid
      WHERE c.contextlevel = " . CONTEXT_COURSE . "
        AND r.archetype IN ('teacher','editingteacher') AND u.deleted = 0
      ORDER BY c.instanceid, ra.userid"
);
$enrollments = [];
foreach ($rs as $r) {
    $enrollments[] = [
        'course_id' => (int)$r->courseid,
        'teacher_id' => (int)$r->userid,
        'teacher_name' => trim((string)$r->firstname . ' ' . (string)$r->lastname),
    ];
}
$rs->close();

// 6. Student Enrollments (Using user_enrolments for reliability)
$rs2 = $DB->get_recordset_sql(
    "SELECT DISTINCT ue.userid, e.courseid, u.firstname, u.lastname
       FROM {user_enrolments} ue
       JOIN {enrol} e ON e.id = ue.enrolid
       JOIN {user} u ON u.id = ue.userid
      WHERE u.deleted = 0 AND ue.status = 0 AND e.status = 0
      ORDER BY e.courseid, ue.userid"
);
$student_enrollments = [];
foreach ($rs2 as $r) {
    $student_enrollments[] = [
        'course_id' => (int)$r->courseid,
        'student_id' => (int)$r->userid,
        'student_name' => trim((string)$r->firstname . ' ' . (string)$r->lastname),
    ];
}
$rs2->close();

// Push to backend
$url = rtrim($server, '/') . '/api/sync/bulk';
$payload = json_encode([
    'secret' => $secret,
    'site_url' => (string)$CFG->wwwroot,
    'courses' => $courses,
    'teachers' => $teachers,
    'students' => $students,
    'quizzes' => $quizzes,
    'enrollments' => $enrollments,
    'student_enrollments' => $student_enrollments,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 30,
    CURLOPT_CONNECTTIMEOUT => 10,
]);
$response = curl_exec($ch);
$err = curl_error($ch);
curl_close($ch);

if ($response === false || $response === '') {
    echo json_encode(['ok' => false, 'error' => $err]);
    exit;
}

$decoded = json_decode($response, true);
if (is_array($decoded) && !empty($decoded['ok'])) {
    echo json_encode($decoded);
} else {
    $msg = is_array($decoded) && isset($decoded['error']) ? $decoded['error'] : 'Unknown error';
    echo json_encode(['ok' => false, 'error' => $msg]);
}

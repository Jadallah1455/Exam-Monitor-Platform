<?php
/**
 * Shared sync logic — collects Moodle data and pushes to the Exam Monitor platform.
 * Returns an HTML message string (for display on the settings page).
 */

defined('MOODLE_INTERNAL') || die();

function exammonitor_do_sync(string $server, string $secret): string {
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
        return '<div class="alert alert-danger" style="margin-top:8px;"><strong>Exam Monitor Sync Failed:</strong> ' . s($err) . '</div>';
    }

    $decoded = json_decode($response, true);
    if (is_array($decoded) && !empty($decoded['ok'])) {
        $s = $decoded['synced'] ?? [];
        return '<div class="alert alert-success" style="margin-top:8px;">'
             . '<strong>Exam Monitor Sync Complete!</strong><br>'
             . 'Courses: ' . ($s['courses'] ?? 0) . ' | '
             . 'Teachers: ' . ($s['teachers'] ?? 0) . ' | '
             . 'Students: ' . ($s['students'] ?? 0) . ' | '
             . 'Quizzes: ' . ($s['quizzes'] ?? 0) . ' | '
             . 'Links: ' . ($s['enrollments'] ?? 0)
             . '</div>';
    }

    $msg = is_array($decoded) && isset($decoded['error']) ? $decoded['error'] : 'Unknown error';
    return '<div class="alert alert-danger" style="margin-top:8px;"><strong>Exam Monitor Sync Error:</strong> ' . s($msg) . '</div>';
}

<?php
/**
 * Admin settings for the exammonitor plugin.
 * After saving, JavaScript auto-syncs all data to the platform.
 */

defined('MOODLE_INTERNAL') || die();

if ($hassiteconfig) {
    $settings->add(new admin_setting_configtext(
        'quizaccess_exammonitor/sync_server',
        get_string('syncserver', 'quizaccess_exammonitor'),
        get_string('syncserverdesc', 'quizaccess_exammonitor'),
        'https://jadallahkhaled.com',
        PARAM_URL
    ));

    $settings->add(new admin_setting_configpasswordunmask(
        'quizaccess_exammonitor/sync_secret',
        get_string('syncsecret', 'quizaccess_exammonitor'),
        get_string('syncsecretdesc', 'quizaccess_exammonitor'),
        ''
    ));

    global $CFG, $PAGE;

    $settings->add(new admin_setting_heading(
        'exammonitor_sync_inject',
        '',
        '<div id="exammonitor-sync-result" style="margin-top:8px"></div>'
    ));

    if (isset($PAGE)) {
        $PAGE->requires->js_init_code('
        (function(){
            var resultDiv = document.getElementById("exammonitor-sync-result");

            function doSync() {
                var server = document.querySelector("input[name=\"quizaccess_exammonitor_sync_server\"]");
                var secret = document.querySelector("input[name=\"quizaccess_exammonitor_sync_secret\"]");
                if (!server || !secret || !server.value || !secret.value) {
                    if (resultDiv) {
                        resultDiv.className = "alert alert-danger";
                        resultDiv.innerHTML = "❌ Exam Monitor: الرجاء إدخال عنوان الخادم والمفتاح السري أولاً";
                    }
                    return;
                }
                if (resultDiv) {
                    resultDiv.className = "alert alert-warning";
                    resultDiv.innerHTML = "⏳ Exam Monitor: جاري مزامنة البيانات...";
                }

                fetch("/mod/quiz/accessrule/exammonitor/sync_api.php", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({sync: 1})
                }).then(function(r){ return r.json(); }).then(function(d){
                    if (d.ok) {
                        var s = d.synced || {};
                        if (resultDiv) {
                            resultDiv.className = "alert alert-success";
                            resultDiv.innerHTML =
                                "<strong style=\"font-size:14px\">✅ تم حفظ الإعدادات والمزامنة بنجاح!</strong><br><br>" +
                                "<table style=\"width:100%;font-size:13px;border-collapse:collapse\">" +
                                "<tr><td style=\"padding:4px 8px;border-bottom:1px solid #ddd\">📦 الدورات التعليمية</td><td style=\"padding:4px 8px;border-bottom:1px solid #ddd;font-weight:bold;text-align:left\">"+(s.courses||0)+"</td></tr>" +
                                "<tr><td style=\"padding:4px 8px;border-bottom:1px solid #ddd\">👨‍🏫 المدرسين</td><td style=\"padding:4px 8px;border-bottom:1px solid #ddd;font-weight:bold;text-align:left\">"+(s.teachers||0)+"</td></tr>" +
                                "<tr><td style=\"padding:4px 8px;border-bottom:1px solid #ddd\">🎓 الطلاب</td><td style=\"padding:4px 8px;border-bottom:1px solid #ddd;font-weight:bold;text-align:left\">"+(s.students||0)+"</td></tr>" +
                                "<tr><td style=\"padding:4px 8px;border-bottom:1px solid #ddd\">📝 الامتحانات</td><td style=\"padding:4px 8px;border-bottom:1px solid #ddd;font-weight:bold;text-align:left\">"+(s.quizzes||0)+"</td></tr>" +
                                "<tr><td style=\"padding:4px 8px;border-bottom:1px solid #ddd\">🔗 ربط المدرسين بالدورات</td><td style=\"padding:4px 8px;border-bottom:1px solid #ddd;font-weight:bold;text-align:left\">"+(s.enrollments||0)+"</td></tr>" +
                                "</table>" +
                                "<br><span style=\"color:#666;font-size:12px\">⏱ آخر مزامنة: "+new Date().toLocaleString("ar-SA")+"</span>";
                        }
                    } else {
                        if (resultDiv) {
                            resultDiv.className = "alert alert-danger";
                            resultDiv.innerHTML = "<strong>❌ فشلت المزامنة:</strong> " + (d.error || "خطأ غير معروف");
                        }
                    }
                }).catch(function(e){
                    if (resultDiv) {
                        resultDiv.className = "alert alert-danger";
                        resultDiv.innerHTML = "<strong>❌ فشل الاتصال بالخادم:</strong> " + e;
                    }
                });
            }

            if (window.location.search.indexOf("saved=1") !== -1) {
                setTimeout(doSync, 500);
                return;
            }

            var target = document.querySelector("[data-region=\"notifications\"]") || document.querySelector(".adminsettings") || document.body;
            var observer = new MutationObserver(function(mutations){
                for (var i = 0; i < mutations.length; i++) {
                    var added = mutations[i].addedNodes;
                    for (var j = 0; j < added.length; j++) {
                        var node = added[j];
                        if (node.nodeType === 1 && (
                            node.classList.contains("alert-success") ||
                            node.classList.contains("success") ||
                            (node.innerHTML && node.innerHTML.indexOf("Changes saved") !== -1) ||
                            (node.innerHTML && node.innerHTML.indexOf("تم حفظ التغييرات") !== -1)
                        )) {
                            observer.disconnect();
                            setTimeout(doSync, 300);
                            return;
                        }
                    }
                }
            });
            observer.observe(target, {childList: true, subtree: true});
        })();
        ');
    }
}

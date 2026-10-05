# CSV catalog · отдельный пример CC

Обсуждай план с пользователем по-русски. `docs/repositories.md` описывает учебный репозиторий catalog: Python 3.12, Ruff, unittest, шесть CSV-записей.

Planner согласует критерии, карту влияния, base/feature-ветки и публикацию; затем создаёт уникальный план и task.json в draftsRoot. `cc_prepare` создаёт wt/<task>/catalog. Пользователь одобряет план в `/tasks`.

Builder работает в Docker через cc_exec. Форматирование → format-check/lint/tests → Reviewer; ошибки возвращаются Builder. Проверяй валидацию CSV, обработку ошибок, пути, тесты и сохранение существующего API. Frozen acceptance checks обязательны.

Результат возвращается пользователю для diff, замечаний и приёмки. Commit, push, MR и Jira требуют согласованной политики и пользовательского действия. Недоступную операцию оформляй через request_user_action. Runtime и проверки CC меняются только по отдельному запросу на пайплайн.

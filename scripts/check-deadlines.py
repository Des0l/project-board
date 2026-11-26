"""Exercise the board in headless Chromium against a temporary, offline database."""

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import socket
import sqlite3
from contextlib import closing
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def check(browser, url):
    page = browser.new_page(viewport={"width": 1280, "height": 850}, locale="ru-RU",
                            timezone_id="America/Los_Angeles", reduced_motion="reduce")
    page.clock.install(time="2026-12-31T20:50:00Z")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    fixtures = [
        ("Вчера", "2026-12-30", "planned"), ("Сегодня", "2026-12-31", "planned"),
        ("Завтра", "2027-01-01", "planned"), ("Через неделю", "2027-01-07", "planned"),
        ("Дальний срок", "2027-01-08", "planned"), ("Завершено", "2026-12-30", "done"),
    ]
    for title, date, status in fixtures:
        response = page.request.post(url + "/api/cards", headers={"X-Board-Action": "1"},
                                     data={"projectId": "local", "title": title, "dueOn": date, "status": status})
        assert response.ok, response.text()
    page.goto(url)

    def card(title):
        return page.locator(".card").filter(has=page.get_by_role("button", name=title, exact=True))

    def badge(title):
        return card(title).locator("time")

    page.locator('button[data-add="planned"]').click()
    page.get_by_label("Название", exact=True).fill("Без срока")
    date_input = page.locator('input[name="dueOn"]')
    expect(date_input).to_have_value("")
    assert not date_input.evaluate("input => input.required")
    page.get_by_role("button", name="Создать задачу", exact=True).click()
    expect(card("Без срока")).to_have_count(1)
    expect(badge("Без срока")).to_have_count(0)
    expect(badge("Вчера")).to_contain_text("Просрочено")
    expect(badge("Сегодня")).to_have_text("Срок сегодня")
    expect(badge("Завтра")).to_contain_text("Завтра")
    expect(badge("Через неделю")).to_contain_text("Через 7 дней")
    expect(page.locator(".card .due.soon")).to_have_count(3)
    expect(page.locator(".card .due.late")).to_have_count(1)
    expect(badge("Через неделю").locator("svg")).to_have_css("animation-name", "none")
    page.emulate_media(reduced_motion="no-preference")
    expect(badge("Через неделю").locator("svg")).to_have_css("animation-name", "due-pulse")
    page.emulate_media(reduced_motion="reduce")
    page.locator("#attention").click()
    expect(page.locator(".card")).to_have_count(4)
    expect(card("Завершено")).to_have_count(0)
    expect(card("Дальний срок")).to_have_count(0)
    page.locator("#attention").click()
    page.locator("#dates-view").click()
    group = page.locator(".agenda-group").filter(has=page.get_by_role("heading", name="В ближайшие 7 дней", exact=False))
    expect(group.locator("time.soon")).to_have_count(2)
    expect(page.locator(".agenda-row")).to_have_count(5)

    page.set_viewport_size({"width": 375, "height": 812})
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.locator("#board-view").click()
    page.clock.fast_forward(11 * 60_000)
    expect(badge("Дальний срок")).to_contain_text("Через 7 дней")
    expect(badge("Завтра")).to_have_text("Срок сегодня")
    expect(badge("Сегодня")).to_contain_text("Просрочено")
    page.get_by_role("button", name="Дальний срок", exact=True).click()
    date_input.fill("")
    page.get_by_role("button", name="Сохранить", exact=True).click()
    page.reload()
    expect(card("Дальний срок")).to_have_count(1)
    expect(badge("Дальний срок")).to_have_count(0)
    assert not errors, errors
    page.close()


def check_snooze(browser, url):
    page = browser.new_page(viewport={"width": 1366, "height": 850}, locale="ru-RU", reduced_motion="reduce")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    today = datetime.now(timezone(timedelta(hours=3))).date()
    tomorrow = today + timedelta(days=1)
    page.clock.install(time=f"{today}T12:00:00+03:00")

    def send(route, payload):
        response = page.request.post(url + "/api/" + route, headers={"X-Board-Action": "1"}, data=payload)
        assert response.ok, response.text()
        return response.json()

    for project, title in [("studio", "Проверить выпуск"), ("local", "Оставить на доске")]:
        send("cards", {"projectId": project, "title": title, "dueOn": str(tomorrow)})
    origin = {"provider": "editor", "session": "chat-1", "event": "draft"}
    send("bridge/tasks", {"projectId": "studio", "mode": "suggest", "source": origin,
                          "title": "Сверить текст", "next": "Проверить три абзаца"})
    send("bridge/questions", {"projectId": "studio", "action": "ask", "source": origin, "question": "Какой формат?"})
    page.goto(url)
    expect(page.locator("#waiting-list")).to_contain_text("Какой формат?")
    card = page.locator(".card").filter(has_text="Проверить выпуск")
    card.scroll_into_view_if_needed()
    box = card.bounding_box()
    x, y = box["x"] + 6, box["y"] + 10
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 25, y + 10, steps=5)
    drop = page.locator("#snooze-drop")
    expect(drop).to_be_visible()
    drop.hover()
    drop.hover()
    page.mouse.up()
    form = page.locator("#snooze-form")
    expect(form).to_be_visible()
    expect(form.locator("select")).to_have_value("item")
    form.get_by_role("button", name="Отложить", exact=True).click()
    expect(card).to_have_count(0)
    page.locator("#dates-view").click()
    expect(page.locator(".agenda-row").filter(has_text="Проверить выпуск")).to_contain_text("Отложено до")
    page.locator("#inbox-view").click()
    row = page.locator(".suggestion-row").filter(has_text="Сверить текст")
    row.get_by_role("button", name="Посмотреть").click()
    expect(page.get_by_role("dialog")).to_contain_text("Проверить три абзаца")
    page.get_by_role("dialog").get_by_role("button", name="Отложить до…").click()
    form.locator("select").select_option("project")
    form.get_by_role("button", name="Через неделю").click()
    form.get_by_role("button", name="Отложить", exact=True).click()
    expect(row).to_have_count(0)
    send("bridge/tasks", {"projectId": "studio", "mode": "suggest", "source": {**origin, "event": "new"},
                          "title": "Проверить дорожку"})
    page.reload()
    expect(page.locator("#inbox-count")).to_have_text("0")
    page.locator("#board-view").click()
    expect(page.locator("#waiting-list")).to_be_hidden()
    expect(page.locator(".card").filter(has_text="Оставить на доске")).to_have_count(1)
    page.set_viewport_size({"width": 375, "height": 812})
    page.locator("#snoozed-view").click()
    expect(page.locator("#content")).to_contain_text("Проверить дорожку")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.get_by_role("button", name="Вернуть проект").click()
    expect(page.locator("#inbox-count")).to_have_text("2")
    expect(page.locator("#snoozed-count")).to_have_text("1")
    page.locator("#board-view").click()
    expect(page.locator("#waiting-list")).to_be_visible()
    page.get_by_role("button", name="Уже ответил").click()
    expect(page.locator("#waiting-list")).to_be_hidden()
    page.clock.fast_forward(12 * 60 * 60 * 1000 + 60_000)
    expect(card).to_have_count(1)
    card.get_by_role("button", name="Отложить до…").click()
    form.get_by_role("button", name="Отмена").click()
    expect(card).to_have_count(1)
    card.get_by_role("button", name="Проверить выпуск", exact=True).click()
    page.locator('#card-form input[name="next"]').fill("Черновик следующего шага")
    page.locator("#card-form").get_by_role("button", name="Отложить до…").click()
    form.get_by_role("button", name="Отмена").click()
    expect(page.locator('#card-form input[name="next"]')).to_have_value("Черновик следующего шага")
    assert not errors, errors
    page.close()


def check_projects(browser, url, data):
    with closing(sqlite3.connect(Path(data) / "board.sqlite")) as db, db:
        db.execute("BEGIN IMMEDIATE")
        board = json.loads(db.execute("SELECT value FROM board WHERE id=1").fetchone()[0])
        src = dict(id="sorting", name="New project", topics=[], roots=[], nameReview="pending")
        board["projects"].append(src)
        board["chats"].extend({"id": key, "title": title, "projectId": src["id"]}
                              for key, title in [("sketches", "Эскизы персонажей"), ("notes", "Заметки редактора"), ("map", "Карта")])
        board["revision"] += 1
        db.execute("UPDATE board SET value=? WHERE id=1", (json.dumps(board),))
    page = browser.new_page(viewport={"width": 1280, "height": 800}, locale="ru-RU", reduced_motion="reduce")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    modal = page.locator("#modal")
    page.locator("#rename-project").click()
    expect(modal.get_by_role("heading", name="Переименовать проект")).to_be_visible()
    # Blank space inside stays open; a click on the backdrop closes only the drawer.
    page.mouse.click(1240, 760)
    expect(modal).to_be_visible()
    page.mouse.click(120, 300)
    expect(modal).to_be_hidden()
    page.locator("#create-project").click()
    modal.get_by_label("Название нового проекта").fill("Игры")
    modal.get_by_role("button", name="Создать проект", exact=True).click()
    expect(modal).to_be_hidden()
    expect(page.locator("#projects")).to_contain_text("Игры")
    page.get_by_role("button", name="Разобрать чаты", exact=True).click()
    transfer = modal.get_by_role("button", name="Перенести", exact=True)
    expect(transfer).to_be_disabled()
    trash = modal.get_by_role("button", name="Удалить с доски", exact=True)
    expect(trash).to_be_disabled()
    modal.get_by_label("Заметки редактора").check()
    trash.click()
    expect(modal.get_by_label("Заметки редактора")).to_have_count(0)
    expect(modal.get_by_label("Эскизы персонажей")).to_be_visible()
    page.keyboard.press("Escape")
    page.locator("#trash-view").click()
    trashed = page.locator(".chat-row").filter(has_text="Заметки редактора")
    expect(trashed).to_contain_text("Чат · New project")
    page.reload()
    trashed.get_by_role("button", name="Восстановить").click()
    expect(trashed).to_have_count(0)
    page.locator("#board-view").click()
    page.get_by_role("button", name="Разобрать чаты", exact=True).click()
    modal.get_by_label("Эскизы персонажей").check()
    modal.get_by_label("Карта", exact=True).check()
    modal.get_by_label("Куда перенести").select_option(label="Игры")
    transfer.click()
    expect(modal.get_by_label("Эскизы персонажей")).to_have_count(0)
    expect(modal.get_by_label("Заметки редактора")).not_to_be_checked()
    page.keyboard.press("Escape")
    page.goto(url + "/#chats")
    row = page.locator(".chat-row").filter(has_text="Заметки редактора")
    row.get_by_role("button", name="Перенести чат").click()
    expect(modal.get_by_label("Заметки редактора")).to_be_checked()
    modal.get_by_label("Название нового проекта").fill("Заметки")
    transfer.click()
    expect(modal.get_by_role("heading", name="«New project» пуст")).to_be_visible()
    modal.get_by_role("button", name="Убрать проект с доски").click()
    expect(modal).to_be_hidden()
    page.reload()
    expect(page.locator("#projects")).not_to_contain_text("New project")
    expect(row).to_contain_text("Заметки")
    expect(page.locator(".chat-row").filter(has_text="Эскизы персонажей")).to_contain_text("Игры")
    page.locator("#project-filter-toggle").click()
    page.get_by_label("Все проекты", exact=True).click()
    page.keyboard.press("Escape")
    with closing(sqlite3.connect(Path(data) / "board.sqlite")) as db, db:
        db.execute("BEGIN IMMEDIATE")
        board = json.loads(db.execute("SELECT value FROM board WHERE id=1").fetchone()[0])
        board["unassignedChats"] = [{"id": key, "title": title, "projectId": "sorting"} for key, title in
                                    [("fresh", "Новые маршруты"), ("another", "Обложка сборника"), ("direct", "Тактика рейда")]]
        board["revision"] += 1
        db.execute("UPDATE board SET value=? WHERE id=1", (json.dumps(board),))
    routing_fixture = """
      import {openStore} from './lib/model.mjs';
      import {suggestProjects} from './lib/chat-routing.mjs';
      const db = openStore(process.argv[1], []);
      try {
        await suggestProjects(db, ({projects, chats}) => chats.map(({chat, title}) => ({
          chat, project: title === 'Обложка сборника' ? null : projects.find(p => p.name === 'Игры').project,
          reason: 'Совпадает с темой уже распределённого чата.'
        })));
      } finally { db.close(); }
    """
    subprocess.run(["node", "--input-type=module", "-e", routing_fixture, str(Path(data) / "board.sqlite")], cwd=ROOT,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=True)
    page.goto(url + "/#inbox")
    page.reload()
    first = page.locator(".suggestion-row").filter(has_text="Новые маршруты")
    second = page.locator(".suggestion-row").filter(has_text="Обложка сборника")
    expect(first).to_contain_text("New project")
    second.get_by_role("button", name="Пропустить").click()
    expect(second).to_have_count(0)
    direct = page.locator(".suggestion-row").filter(has_text="Тактика рейда")
    expect(direct).to_contain_text("Совпадает с темой")
    direct.get_by_role("button", name="Перенести в «Игры»").click()
    expect(direct).to_have_count(0)
    first.get_by_role("button", name="Выбрать другой").click()
    modal.get_by_label("Куда перенести").select_option(label="Заметки")
    modal.get_by_role("button", name="Перенести чат").click()
    expect(first).to_have_count(0)
    response = page.request.get(url + "/api/state").json()
    assigned = {c["id"]: c["projectId"] for c in response["chats"]}
    projects = {p["name"]: p["id"] for p in response["projects"]}
    assert assigned["direct"] == projects["Игры"] and assigned["fresh"] == projects["Заметки"]
    page.locator("#trash-view").click()
    page.locator(".chat-row").filter(has_text="Обложка сборника").get_by_role("button", name="Восстановить").click()
    page.locator("#inbox-view").click()
    second.get_by_role("button", name="Выбрать проект").click()
    modal.get_by_label("Куда перенести").select_option(label="Создать новый проект")
    modal.get_by_label("Название нового проекта").fill("Сборник")
    modal.get_by_role("button", name="Перенести чат").click()
    expect(second).to_have_count(0)
    expect(page.locator("#projects")).not_to_contain_text("New project")
    page.locator("#trash-view").click()
    removed_project = page.locator(".chat-row").filter(has_text="New project")
    expect(removed_project.locator("small")).to_have_text("Проект")
    removed_project.get_by_role("button", name="Восстановить").click()
    expect(page.locator("#projects [data-project=sorting]")).to_be_visible()
    expect(removed_project).to_have_count(0)
    page.set_viewport_size({"width": 320, "height": 700})
    expect(page.locator("#create-project")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.locator("#create-project").click()
    expect(modal.get_by_label("Название нового проекта")).to_be_visible()
    modal.get_by_role("button", name="Закрыть").click()
    assert not errors, errors
    page.close()


def check_project_filter(browser, url):
    page = browser.new_page(viewport={"width": 672, "height": 600}, locale="ru-RU", reduced_motion="reduce")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    headers = {"X-Board-Action": "1"}
    for n in range(10):
        added = page.request.post(url + "/api/projects", headers=headers, data={"name": f"Проект с длинным названием {n}"})
        assert added.ok
    for project in ["local", "studio"]:
        assert page.request.post(url + "/api/cards", headers=headers, data={"projectId": project, "title": "Filter test " + project}).ok
    page.goto(url)
    toggle = page.locator("#project-filter-toggle")
    options = page.locator("#project-options")
    tags = page.locator("#projects .project-tag")
    all_projects = options.get_by_role("checkbox", name="Все проекты", exact=True)
    local = options.get_by_role("checkbox", name="local", exact=True)
    studio = options.get_by_role("checkbox", name="studio", exact=True)
    local_card = page.locator(".card").filter(has_text="Filter test local")
    studio_card = page.locator(".card").filter(has_text="Filter test studio")
    expect(tags.first).to_be_visible()
    toggle.click()
    assert options.get_by_role("checkbox").count() > 12
    all_projects.uncheck()
    expect(tags).to_have_count(0)
    expect(local_card).to_have_count(0)
    local.check()
    studio.check()
    expect(tags).to_have_count(2)
    expect(studio_card).to_be_visible()
    assert all_projects.evaluate("el => el.indeterminate")
    studio.uncheck()
    expect(studio_card).to_have_count(0)
    expect(local_card).to_be_visible()
    expect(tags).to_have_count(1)
    expect(options).to_be_visible()
    page.keyboard.press("Escape")
    expect(toggle).to_be_focused()
    page.reload()
    expect(tags).to_have_count(1)
    expect(tags.first).to_contain_text("local")
    expect(options).to_be_hidden()
    page.get_by_role("button", name="Скрыть проект «local»", exact=True).click()
    expect(tags).to_have_count(0)
    expect(toggle).to_be_focused()
    toggle.click()
    local.check()
    studio.check()
    page.get_by_role("heading", name="Общая доска").click()
    expect(options).to_be_hidden()

    page.locator('#projects [data-project="studio"] .project-name').click()
    expect(page.locator("#settings-project")).to_have_value("studio")
    expect(tags).to_have_count(2)
    page.locator("#modal").get_by_role("button", name="Закрыть").click()
    page.locator('#projects [data-project="local"] circle').click()
    expect(page.locator("#settings-project")).to_have_value("local")
    picker = page.get_by_label("Цвет проекта", exact=True)
    picker.fill("#ea6030")
    local_dot = page.locator('#projects [data-project="local"] circle')
    expect(local_dot).to_have_attribute("fill", "#ea6030")
    expect(local_card.locator(".project-mark circle")).to_have_attribute("fill", "#ea6030")
    page.reload()
    expect(local_dot).to_have_attribute("fill", "#ea6030")
    page.get_by_role("button", name="Скрыть проект «studio»", exact=True).click()
    expect(tags).to_have_count(1)
    expect(local_card).to_be_visible()
    toggle.click()
    expect(options.locator('input[value="local"] + svg circle')).to_have_attribute("fill", "#ea6030")
    all_projects.check()
    total = options.locator("#project-options-list input").count()
    expect(tags).to_have_count(total)
    page.keyboard.press("Escape")
    for width in [280, 320, 390, 600, 601, 672, 768, 1024, 1100, 1101, 1280, 1920]:
        page.set_viewport_size({"width": width, "height": 700})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), width
        bar = page.locator(".project-bar").bounding_box()
        assert bar["height"] <= 115, (width, bar)
        assert len(set(tags.evaluate_all("els => els.map(el => el.offsetTop)"))) == 1
        toggle.click()
        panel = options.bounding_box()
        assert panel["x"] >= 0 and panel["x"] + panel["width"] <= width
        assert page.locator(".project-bar").bounding_box()["height"] == bar["height"]
        page.keyboard.press("Escape")
    page.set_viewport_size({"width": 320, "height": 700})
    page.goto(url + "/#trash")
    current = page.locator("#trash-view")
    expect(current).to_have_attribute("aria-pressed", "true")
    assert current.evaluate("""button => {
        const nav = button.parentElement.getBoundingClientRect(), tab = button.getBoundingClientRect();
        return tab.left >= nav.left && tab.right <= nav.right;
    }""")
    assert not errors, errors
    page.close()


def check_chat_description(browser, url):
    page = browser.new_page(locale="ru-RU")
    title = "Сверить выгрузку остатков"
    evidence = "В выгрузке должны остаться строки с нулевым остатком."
    headers = {"X-Board-Action": "1"}
    receipt = page.request.post(url + "/api/bridge/tasks", headers=headers, data={
        "projectId": "local", "title": title, "description": evidence, "mode": "suggest",
        "source": {"provider": "claude", "session": "s", "event": "m"}
    })
    assert receipt.ok
    page.goto(url + "/#inbox")
    row = page.locator(".suggestion-row").filter(has_text=title)
    expect(row.locator(".offer-description")).to_have_text(evidence)
    row.get_by_role("button", name="Добавить на доску").click()

    def stored():
        return next(c for c in page.request.get(url + "/api/state").json()["cards"] if c["title"] == title)

    card = stored()
    assert card["description"] == evidence
    address = url + "/api/cards/" + card["id"]
    assert page.request.patch(address, headers=headers, data={"description": ""}).ok
    page.goto(url)
    opener = page.get_by_role("button", name=title, exact=True)
    shortcut = page.locator(".card").filter(has=opener).get_by_role("button", name="Подтянуть из чата")
    shortcut.click()
    modal = page.locator("#modal")
    field = modal.get_by_label("Описание", exact=True)
    pull = modal.get_by_role("button", name="Подтянуть из чата")
    expect(field).to_have_value(evidence)
    field.fill("Черновая правка")
    modal.get_by_role("button", name="Закрыть").click()
    assert stored()["description"] == ""
    opener.click()
    field.fill("Проверяет редактор.")
    pull.click()
    expect(modal.locator("[data-preview-text]")).to_have_text(evidence)
    expect(field).to_have_value("Проверяет редактор.")
    modal.get_by_role("button", name="Добавить к описанию").click()
    expect(field).to_have_value("Проверяет редактор.\n\n" + evidence)
    field.fill("Проверяет редактор. Сохранить нулевые остатки.")
    modal.get_by_role("button", name="Сохранить", exact=True).click()
    expect(modal).to_be_hidden()
    assert stored()["description"] == "Проверяет редактор. Сохранить нулевые остатки."
    expect(shortcut).to_have_count(0)
    assert stored()["status"] == card["status"]
    page.close()


def check_draft_queue(browser, url):
    page = browser.new_page(locale="ru-RU")
    headers = {"X-Board-Action": "1"}
    titles = ["Очередь описаний A", "Очередь описаний B"]
    for title in titles:
        receipt = page.request.post(url + "/api/bridge/tasks", headers=headers, data={
            "projectId": "local", "title": title, "description": "Текст из чата", "mode": "add",
            "source": {"provider": "claude", "session": "queue", "event": title}
        })
        assert receipt.ok
        cards = page.request.get(url + "/api/state").json()["cards"]
        card = next(c for c in cards if c["title"] == title)
        assert page.request.patch(url + "/api/cards/" + card["id"], headers=headers, data={"description": ""}).ok
    page.goto(url)
    open_queue = page.get_by_role("button", name="Черновики описаний")
    open_queue.click()
    modal = page.locator("#modal")
    prepare = modal.get_by_role("button", name="Подтянуть для всех")
    prepare.click()
    rows = [modal.locator(".draft-review-row").filter(has_text=t) for t in titles]
    field = rows[0].locator("textarea")
    expect(field).to_have_value("Текст из чата")
    field.fill("Моя правка на потом")
    rows[1].get_by_role("button", name="Пропустить").click()
    expect(rows[1]).to_have_count(0)
    expect(field).to_have_value("Моя правка на потом")
    rows[0].get_by_role("button", name="Оставить черновиком").click()
    expect(rows[0]).to_contain_text("Правки сохранены в черновике")
    page.goto(url + "/#inbox")
    page.reload()
    group = page.locator(".review-inbox")
    expect(group.get_by_role("heading", name="Черновики описаний 1")).to_be_visible()
    expect(page.get_by_text("Всё разобрано на сегодня")).to_have_count(0)
    group.get_by_role("button", name="Проверить черновики").click()
    expect(field).to_have_value("Моя правка на потом")
    prepare.click()
    expect(prepare).to_be_enabled()
    expect(rows[1]).to_have_count(0)
    rows[0].get_by_role("button", name="Сохранить в карточку").click()
    expect(rows[0]).to_have_count(0)
    cards = page.request.get(url + "/api/state").json()["cards"]
    assert [next(c["description"] for c in cards if c["title"] == t) for t in titles] == ["Моя правка на потом", ""]
    page.close()


def check_empty_layout(browser, url):
    page = browser.new_page(locale="ru-RU", reduced_motion="reduce")
    page.goto(url + "/#inbox")
    expect(page.get_by_text("Всё разобрано на сегодня")).to_be_visible()
    page.evaluate("document.fonts.ready")
    for width, height in [(1920, 1080), (2560, 1080), (390, 844)]:
        page.set_viewport_size({"width": width, "height": height})
        for view in ["inbox", "dates", "focus", "chats", "snoozed", "trash"]:
            view_button = page.locator("#" + view + "-view")
            view_button.click()
            expect(view_button).to_have_attribute("aria-pressed", "true")
            empty = "#content > :is(.agenda-empty, .empty-page)"
            expect(page.locator(empty)).to_be_visible()
            geometry = page.eval_on_selector(empty, """node => {
                const range = document.createRange();
                range.selectNodeContents(node);
                const visible = range.getBoundingClientRect();
                const area = document.querySelector('.workspace').getBoundingClientRect();
                return {
                    dx: (visible.left + visible.right - area.left - area.right) / 2,
                    dy: (visible.top + visible.bottom - node.getBoundingClientRect().top - innerHeight
                        + parseFloat(getComputedStyle(document.querySelector('main')).paddingBottom)) / 2,
                    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
                };
            }""")
            assert abs(geometry["dx"]) < 3, (width, view, geometry)
            if width >= 791:
                assert abs(geometry["dy"]) < 5, (width, view, geometry)
            assert geometry["overflow"] <= 1, (width, view, geometry)
    page.close()


def check_language(browser, url):
    page = browser.new_page(viewport={"width": 1280, "height": 850}, locale="en-US")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    expect(page.locator("html")).to_have_attribute("lang", "en")
    expect(page.locator("#page-title")).to_have_text("Project board")
    expect(page.locator("#content h2").filter(has_text="Planned").first).to_be_visible()
    title = "Задача с исходным языком"
    page.locator("#quick-title").fill(title)
    page.locator("#quick-title").press("Enter")
    page.get_by_role("button", name="Create task", exact=True).click()
    expect(page.get_by_role("button", name=title, exact=True)).to_be_visible()

    page.get_by_role("button", name="Board and project settings", exact=True).click()
    page.get_by_label("Interface language").select_option("ru")
    expect(page.locator("html")).to_have_attribute("lang", "ru")
    expect(page.get_by_label("Язык интерфейса")).to_have_value("ru")
    expect(page.locator("#page-title")).to_have_text("Общая доска")
    page.reload()
    expect(page.get_by_role("button", name=title, exact=True)).to_be_visible()
    page.get_by_role("button", name="Настройки доски и проекта", exact=True).click()
    page.get_by_label("Язык интерфейса").select_option("system")
    expect(page.locator("html")).to_have_attribute("lang", "en")
    expect(page.get_by_label("Interface language")).to_have_value("system")
    assert not errors, errors
    page.close()

    mobile = browser.new_page(viewport={"width": 390, "height": 844}, locale="ru-RU", is_mobile=True, has_touch=True)
    mobile.goto(url + "/#inbox")
    expect(mobile.locator("#page-title")).to_have_text("Неразобранные задачи")
    mobile.get_by_role("button", name="Настройки доски и проекта", exact=True).click()
    mobile.get_by_label("Язык интерфейса").select_option("en")
    expect(mobile.get_by_label("Interface language")).to_be_visible()
    expect(mobile.locator("#page-title")).to_have_text("Inbox")
    mobile.close()


def main():
    scratch = ROOT / ".work" / "test-temp"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as data:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        config = Path(data) / "projects.local.json"
        config.write_text(json.dumps({"projects": [{"id": key, "name": key, "roots": [str(Path(data) / key)]}
                                                   for key in ["local", "studio"]]}), encoding="utf-8")
        env = dict(os.environ, PROJECT_BOARD_OFFLINE="1", PROJECT_BOARD_PORT=str(port),
                   PROJECT_BOARD_DATA=data, PROJECT_BOARD_ROOT=data, PROJECT_BOARD_PROJECTS=str(config))
        server = subprocess.Popen(["node", "server.mjs"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError("The test server exited during startup")
                try:
                    with urlopen(url + "/api/state", timeout=1):
                        break
                except URLError:
                    time.sleep(0.05)
            else:
                raise RuntimeError("The test server did not start")
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, executable_path=os.getenv("CHROMIUM_PATH"))
                check_empty_layout(browser, url)
                check(browser, url)
                check_snooze(browser, url)
                check_projects(browser, url, data)
                check_project_filter(browser, url)
                check_chat_description(browser, url)
                check_draft_queue(browser, url)
                check_language(browser, url)
                browser.close()
        finally:
            server.terminate()
            server.wait(timeout=10)


if __name__ == "__main__":
    main()

---
layout: default
title: 홈
---

설계& 트러블 슈팅& 깊게 공부한 내용들을 정리하는 공간입니다.

## 최근 글

<ul>
  {% for post in site.posts limit:10 %}
    <li>
      <a href="{{ post.url | relative_url }}">{{ post.title }}</a>
      <small> ({{ post.date | date: "%Y-%m-%d" }}) </small>
    </li>
  {% endfor %}
</ul>

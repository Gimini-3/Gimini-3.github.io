---
layout: default
title: 홈
---

[![Today / Total](https://myhits.vercel.app/api/hit/https%3A%2F%2Fhttps%3A%2F%2Fgimini-3.github.io%2F?color=blue&label=Today+%2F+Total&size=small)](https://myhits.vercel.app)

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

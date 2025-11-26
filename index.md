---
layout: default
title: 홈
---

# Gimin의 기술 블로그

백엔드, 인프라, 네트워크 공부하면서 정리하는 공간입니다.

- Spring / JPA / MySQL
- AWS (EC2, RDS, VPC)
- 네트워크 / HTTP / 운영체제

## 최근 글

<ul>
  {% for post in site.posts limit:10 %}
    <li>
      <a href="{{ post.url | relative_url }}">{{ post.title }}</a>
      <small> ({{ post.date | date: "%Y-%m-%d" }}) </small>
    </li>
  {% endfor %}
</ul>

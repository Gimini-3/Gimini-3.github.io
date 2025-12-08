---
title: "[Docker Troubleshooting] Spring Redis UnknownHostException 해결기: Spring 앱과 Redis의 외부 네트워크와 DNS 스코프 문제"
date: 2025-12-08 13:30:00 +0900
tags:
  - docker
  - docker-compose
  - redis
  - spring
  - networking
  - dns
  - ec2
  - devops
  - troubleshooting
thumbnail: "/assets/img/thumbnail/docker-redis-network-dns.png"
---

# Spring Redis UnknownHostException 해결기:  Spring 앱과 Redis의 외부 네트워크와 DNS 스코프 문제

Redis UnknownHostException 문제를 Docker 네트워크/ DNS 관점에서 추적한 기록

배포 환경에서 Spring 앱이 Redis에 붙지 못하며 `UnknownHostException: redis`가 발생했다. 단순한 “Redis 다운” 문제가 아니라, **컨테이너 네트워크와 DNS 스코프가 어긋난 설정 문제**였다.

이 글은 실제로 내가 문제를 재현하고, 네트워크를 확인하고, 원인을 좁혀가며 해결한 과정을 정리한 기록이다.

---

## 1) 컨테이너가 어떤 네트워크에 붙어있는지 확인

먼저 앱 컨테이너, Redis 컨테이너, MySQL 컨테이너가 각각 어떤 네트워크에 붙어 있는지 확인했다.

```bash
docker inspect oneco-redis \
  --format '{{json .NetworkSettings.Networks}}'
```

출력은 대략 아래와 같았다.

```json
{
  "oneco_oneco-network": {
    "IPAMConfig": null,
    "Links": null,
    "Aliases": [
      "oneco-redis",
      "redis"
    ],
    ...
    "DNSNames": [
      "oneco-redis",
      "redis",
      "0eb40bfab1c1"
    ]
  }
}
```

확인 결과

- Redis는 네트워크 그룹이 `oneco_oneco-network`
- MySQL과 Spring 앱은 네트워크 그룹이 `oneco-network`

였다.

즉, **같은 서비스끼리 서로 다른 “방(네트워크)”에 들어가 있는 상태**였다.

---

## 그렇다면 도커 네트워크란 무엇일까?

도커 네트워크는 컨테이너들이

- 서로 IP로 직접 통신할 수도 있고
- 이름(DNS)으로 서로를 찾게 해주는 공간이다.

Spring 앱 컨테이너가 `oneco-network`라는 방에 들어가 있고

Redis 컨테이너도 같은 `oneco-network`에 들어가 있으면

두 컨테이너는 이름으로 서로를 찾고 통신할 수 있다.

그래서 먼저 Redis를 `oneco-network`에 연결했다.

```bash
docker network connect oneco-network oneco-redis
```

이후 Redis도 `oneco-network`에 연결되었다.

---

## 1-1) 추후 안정성을 위해 compose에 외부 네트워크 선언

수동 연결은 재배포/재생성 시 다시 꼬일 수 있으므로

추후에도 안정적으로 유지되도록 docker-compose에도 다음 설정을 추가했다.

```yaml
networks:
  oneco-network:
    external: true
    name: oneco-network
```

각 항목의 의미는 다음과 같다.

- `networks:`
    - compose에서 사용할 네트워크들을 정의하는 영역
- `oneco-network:`
    - compose 내부에서 참조할 네트워크 키(name)
    - 서비스에서 `networks: [oneco-network]`처럼 사용할 때 이 이름을 참조
- `external: true`
    - 이 네트워크는 compose가 생성/관리하지 않는다는 의미
    - 따라서 `docker compose up` 이전에 해당 네트워크가 **미리 존재**해야 한다
- `name: oneco-network`
    - 도커 엔진에서 실제로 찾을 네트워크 이름을 지정
    - 프로젝트명 기반 자동 네이밍을 피하고 정확히 이 네트워크를 사용하겠다는 선언

이렇게 하면 **compose로 실행되는 컨테이너들이 동일한 `oneco-network`에 붙어 문제를 해결할 수 있을 것**이라 기대했다.

하지만 다시 실행해보니 여전히 다음 오류가 발생했다.

---

## 2) `UnknownHostException: redis`

원인을 분석해보니,

**`oneco-network` 안에서 `redis`라는 이름이 해석되지 않아**

`UnknownHostException: redis`가 발생한 상황이었다.

---

### 내 inspect 결과를 해석하면

### 백엔드

- 네트워크: `oneco-network`
- DNSNames: `oneco-container-dev-live-gimin`

### MySQL

- `oneco-network`에서 alias가 정상적으로 잡힘
    - `Aliases: ["oneco-mysql", "mysql"]`

### Redis

- `oneco-network` 쪽
    - `Aliases: []` ← 핵심
    - `DNSNames`에는 `oneco-redis`가 존재
- `oneco_oneco-network` 쪽
    - `Aliases: ["oneco-redis", "redis"]`

즉, **`REDIS_HOST=redis`로 설정한 상태에서**

Spring 앱이 붙어 있는 `oneco-network` 스코프에서는

`redis`라는 alias가 없기 때문에 이름 해석이 실패했다.

---

## 3) Docker DNS 내부 동작 원리

도커에는 **내장 DNS(Embedded DNS)**가 있다.

- 컨테이너 이름/alias를 이름 해석 대상으로 제공한다.

컨테이너 내부에서 일반적으로 동작하는 흐름은 다음과 유사하다.

1. 백엔드 앱이 `redis`로 접속을 시도
2. OS 레벨에서 이름 해석 호출

   예: `getaddrinfo("redis")`

3. 컨테이너의 `/etc/resolv.conf`에 설정된 DNS로 질의
4. 도커 내장 DNS가 응답

이때 중요한 점은

**도커 내장 DNS는 네트워크 스코프로 이름을 관리한다**는 것이다.

즉,

- 백엔드 컨테이너가 속한 네트워크에서
- `redis`라는 이름이 등록돼 있어야만
- IP로 변환이 가능하다.

그래서 내 케이스처럼

- Redis 컨테이너가 네트워크에 추가로 붙어 있어도
- **그 네트워크 endpoint에 alias(`redis`)가 없으면**
- `redis` 이름은 해석되지 않는다.

이 단계에서 터지는 게 바로

**UnknownHostException**이다.

연결 시도 이전에 **이름 → IP 변환이 실패한 것**이다.

---

## 해결책 1) `.env`의 `REDIS_HOST` 변경(응급처치)

프론트와 연동 테스트가 급한 상황이라

우선 응급처치로 `REDIS_HOST`를 바꿔 확인했다.

- `oneco-network`에서 Redis의 `DNSNames`에 `oneco-redis`가 보였으므로
- `.env`에서

```bash
REDIS_HOST=oneco-redis
```

로 변경했다.

그 결과 문제는 일단 해결되었다.

하지만 이 방식은 근본 해결이 아니라

“우연히 해당 네트워크 스코프에서 해석 가능한 이름을 선택한” 임시 대응이었다.

---

## Alias가 계속 비어있는데 정상 실행되는 이유는 무엇일까?

다시 상태를 확인해 보았다.

```bash
docker inspect oneco-redis \
  --format '{{json .NetworkSettings.Networks}}'
```

```json
{
  "oneco-network": {
    "Aliases": [],
    ...
    "DNSNames": [
      "oneco-redis",
      "0eb40bfab1c1"
    ]
  },
  "oneco_oneco-network": {
    "Aliases": [
      "oneco-redis",
      "redis"
    ],
    ...
    "DNSNames": [
      "oneco-redis",
      "redis",
      "0eb40bfab1c1"
    ]
  }
}
```

`oneco-network`에는 alias가 비어 있지만

`DNSNames`에는 `oneco-redis`가 존재했다.

즉, `.env`에서 `REDIS_HOST=oneco-redis`로 바꾼 이유는

**alias에 의존하지 않아도 컨테이너 이름이 해석 가능했기 때문**이었다.

---

## alias와 DNSNames는 무엇이 다른가?

### alias란?

- 특정 네트워크 스코프에서 사용하는 별칭이다.
- 같은 컨테이너라도 네트워크 A에서는 alias가 있고

  네트워크 B에서는 없을 수 있다.


예를 들어

- `oneco_oneco-network`에는 `Aliases: ["oneco-redis", "redis"]`
- `oneco-network`에는 `Aliases: []`

처럼 네트워크마다 다르게 보일 수 있다.

---

### DNSNames란?

- 도커 내장 DNS가 해당 네트워크에서

  이 컨테이너를 **어떤 이름들로 해석해줄지** 보여주는 목록이다.

- 보통 포함되는 값은
    - 컨테이너 이름
    - alias
    - 컨테이너 ID 일부

예:

```bash
"DNSNames": [
  "oneco-redis",
  "redis",
  "0eb40bfab1c1"
]
```

따라서 alias가 비어 있어도

`DNSNames`에 컨테이너 이름이 들어 있을 수 있다.

---

## 근본 해결: 외부 네트워크에서 alias를 명시적으로 관리

`redis` alias를 확실히 보장하기 위해

docker-compose에 다음 설정을 추가했다.

```yaml
services:
  redis:
    networks:
      oneco-network:
        aliases:
          - redis
          - oneco-redis
```

그리고 다시 compose를 올렸다.

```bash
docker compose \
  -f /opt/oneco/docker-compose.gimin.yml \
  -f /opt/oneco/docker-compose.prod.gimin.yml \
  up -d
```

올린 뒤 inspect를 보면

```bash
"Aliases":["oneco-redis","redis","redis","oneco-redis"]
```

처럼 중복된 항목이 표시되었다.

기능적으로는 동작에 문제가 없었지만

표현이 중복되는 이유를 정리해보면 다음과 같다.

---

## 왜 alias가 중복으로 표시됐을까?

Compose는 보통

- 프로젝트 전용 기본 네트워크를 만들고
- 그 네트워크에서
    - 서비스명(`redis`)
    - 컨테이너명(`oneco-redis`)

같은 이름을 alias/DNS로 자동 등록해준다.

그래서 처음에 Redis가 붙어 있던

`oneco_oneco-network`에서는 이런 형태로 자연스럽게 등록돼 있었다.

```yaml
"Aliases": [
  "oneco-redis",
  "redis"
],
...
"DNSNames": [
  "oneco-redis",
  "redis",
  "0eb40bfab1c1"
]
```

하지만 나는 Redis를 나중에

- 외부 네트워크(`oneco-network`)에

  수동으로 추가 연결하는 과정을 거쳤다.


이 연결은 compose 관리 영역 밖에서 생긴 관계라

`oneco-network` endpoint에는

compose가 자동으로 서비스명 alias를 넣어주지 않았던 것으로 보인다.

---

## 최종 정리: 외부 네트워크 선언 + compose 재정렬로 해결

그래서 네트워크 연결을 compose 설정에 명시하고

```yaml
networks:
  oneco-network:
    external: true
    name: oneco-network
```

Redis 서비스의 alias를 별도로 덧붙이지 않은 상태에서

다시 compose up을 수행했다.

그 결과

```bash
"Aliases":["oneco-redis","redis"]
```

로 중복 없이 정리된 상태를 확인할 수 있었다.

즉,

- **서비스에 외부 네트워크를 명시적으로 붙인 상태에서**
- `compose up`으로 **네트워크 엔드포인트가 compose 관리 하에 재조정되며**
- 서비스명 기반 alias가 정상 반영될 수 있었다

고 판단했다.

---

## 결론

이번 문제는 Redis 서버 장애가 아니라

- 컨테이너가 서로 다른 네트워크에 붙어 있었고
- 같은 네트워크에 붙은 뒤에도
- **해당 네트워크 스코프에서 `redis` alias가 등록되지 않아**
- 이름 해석이 실패한 케이스였다.

결과적으로

- `external network`를 명시하고
- `compose`가 네트워크 엔드포인트를 일관되게 관리하도록 구성해

`REDIS_HOST=redis`를 안정적으로 유지할 수 있었다.
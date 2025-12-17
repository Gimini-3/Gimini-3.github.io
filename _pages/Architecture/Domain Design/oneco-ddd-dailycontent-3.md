---
title: "[ONECO DDD 도메인 설계 시리즈 Part 3] DailyContent 애그리거트 설계 스토리"
date: 2025-12-17 13:32:00 +0900
tags:
  - DDD
  - domain-driven design
  - domain design
  - architecture
  - aggregate
  - domain model
  - entity
  - value object
thumbnail: "/assets/img/thumbnail/oneco-ddd-dailycontent.png"
---
# [ONECO DDD 도메인 설계 시리즈 Part 3] 값 객체는 어디서 만들고, 엔티티는 누가 만들어야 할까?

이번 글은 ONECO 프로젝트에서 DailyContent 애그리거트를 설계하면서 부딪힌 고민들을 바탕으로,

**“값 객체(Value Object)는 어디서 만들고, 엔티티(Entity)는 누가 만들게 할 것인가?”** 를 정리해보는 글이다.

실제로 프로젝트를 진행하며 작성한 코드들로 정리해보았다.

---

## 0. 개념 정리 : 엔티티 vs 값 객체

- 엔티티(Entity)
    - **ID(정체성)** 으로 구분된다.
    - 값이 조금 바뀌어도 “그 객체”로 계속 취급돼야 한다.
    - 애그리거트 루트 아래에 매달려 있는 내부 엔티티(예: OrderLine, Comment 등)도 포함.
- 값 객체(Value Object)
    - ID가 없다.
    - **값이 같으면 같은 것**이다.
    - 가능하면 불변(immutable)에 가깝게 두고, 생성 시점에 유효성 검증을 끝낸다.

> “값 객체는 서비스에서 만들어도 되는데,
>
>
> 엔티티는 애그리거트 루트 안에서만 만들게 막자.”
>

이 글은 oneco 프로젝트에서

- `DailyContent` 애그리거트
- 그 안의 `NewsItem`, `Quiz` 엔티티
- `CategoryId`, `DaySequence`, `Keyword` 같은 값 객체들

을 설계하면서 정리한, **실제 도메인 기준 원칙**이다.

---

## 1. 한 줄 요약: 내 프로젝트에서 잡은 원칙

oneco에서는 이렇게 원칙을 잡았다.

1. **값 객체(Value Object)**
    - 서비스에서 만들어서 애그리거트에 넘겨도 된다.
    - 단, **유효성 검증은 VO 자체**가 책임진다.

      (예: `Keyword.of(...)` 안에서 길이/공백 검증)

2. **엔티티(Entity)**
    - 서비스에서 `new` 하지 않는다.
    - **항상 애그리거트 루트(`DailyContent`, `Mission` 등) 안의 도메인 메서드**로만 생성/추가/삭제한다.
    - ex) `dc.addNewsItem(...)`, `dc.addQuiz(...)` 같은 메서드.

이걸 oneco 도메인에 그대로 적용하면 이렇게 된다.

- VO 예시
    - `CategoryId`, `DaySequence`, `Keyword`, `ContentDescription`, `ImageFile`, `WebLink`,

      `NewsItemOrder`, `QuestionOrder`, `AnswerIndex`, `QuizOptions`, `QuizOption` …

- 엔티티 예시
    - `DailyContent`(AR), `NewsItem`, `Quiz`

---

## 2. DailyContent: 값 객체는 서비스에서 조립, 불변식은 루트에서 검증

### 2.1 DailyContent 생성 플로우

서비스에서 하루치 콘텐츠를 만들 때 흐름은 대략 이런 느낌이다:

```java
@Transactional
public DailyContent createDailyContent(CreateDailyContentCommand cmd) {

    DailyContent dailyContent = DailyContent.create(
        CategoryId.of(cmd.categoryId()),
        new DaySequence(cmd.daySequence()),
        Keyword.of(cmd.keyword()),
        ContentDescription.of(cmd.title(), cmd.summary(), cmd.body()),
        ImageFile.of(cmd.imageUrl())
    );

    return dailyContentRepository.save(dailyContent);
}

```

여기서 역할 분리를 보면:

- **서비스의 역할**
    - 외부 요청 DTO → 도메인 값 객체로 변환
    - 어떤 애그리거트를 만들지 결정
    - 리포지토리로 저장
- **값 객체의 역할**
    - 자기 값이 유효한지 검증
        - `CategoryId.of(...)` → 양수인지
        - `Keyword.of(...)` → 공백/길이 제한
        - `ContentDescription.of(...)` → 제목/요약/본문이 비어 있지 않은지 + 길이
- **DailyContent의 역할**
    - “카테고리 + 일차 + 키워드 + 설명 + 이미지”라는 조합 자체가 유효한지 체크
    - `categoryId`, `daySequence`, `keyword`, `description`, `imageFile`이 null이 아닌지 검증

즉, **값 객체는 서비스에서 만들어도 되지만, 최종 조합이 도메인 규칙을 만족하는지는 루트에서 한 번 더 본다**는 구조다.

---

## 3. NewsItem / Quiz: 왜 엔티티는 DailyContent 안에서만 만들게 했나?

### 3.1 NewsItem: 순번/링크/이미지까지 DailyContent가 책임

`DailyContent`에는 뉴스 목록이 있다:

```java
@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
@JoinColumn(name = "daily_content_id", nullable = false)
private List<NewsItem> newsItems = new ArrayList<>();

```

여기에 뉴스 하나를 추가하는 메서드는 이렇게 되어 있다:

```java
public NewsItem addNewsItem(
    String title,
    NewsItemOrder order,
    WebLink link,
    ImageFile imageFile
) {
    Objects.requireNonNull(title, "title은 null일 수 없다.");
    Objects.requireNonNull(order, "order는 null일 수 없다.");
    Objects.requireNonNull(imageFile, "imageFile은 null일 수 없다.");
    Objects.requireNonNull(link, "link는 null일 수 없다.");

    validateNewsOrderDuplicate(order); // 순번 중복 검증

    NewsItem item = NewsItem.create(title, link, order, imageFile);
    newsItems.add(item);
    return item;
}

```

중요한 포인트:

- `NewsItem`을 **서비스에서 직접 new 하지 않는다.**
- `DailyContent`가
    - 필수 값 null 체크
    - **순번 중복 방지(`validateNewsOrderDuplicate`)**
    - 컬렉션 관리(add/remove)

      를 전부 책임진다.


서비스는 이런 식으로만 호출한다:

```java
@Transactional
public void addNewsToDailyContent(Long dailyContentId, AddNewsCommand cmd) {
    DailyContent dc = dailyContentRepository.findById(dailyContentId)
        .orElseThrow(...);

    dc.addNewsItem(
        cmd.title(),
        new NewsItemOrder(cmd.order()),
        WebLink.of(cmd.url()),
        ImageFile.of(cmd.imageUrl())
    );
}

```

여기서도

**VO는 서비스에서 만들고, 엔티티는 루트에서 만든다**라는 패턴이 그대로 적용된다.

---

### 3.2 Quiz: 정답 인덱스 범위까지 루트가 보장

퀴즈도 마찬가지 구조다.

`DailyContent` 쪽:

```java
@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
@JoinColumn(name = "daily_content_id", nullable = false)
private List<Quiz> quizzes = new ArrayList<>();
```

추가 메서드:

```java
public Quiz addQuiz(
    String question,
    QuestionOrder order,
    QuizOptions options,
    AnswerIndex answerIndex
) {
    Objects.requireNonNull(question, "question은 null일 수 없다.");
    Objects.requireNonNull(order, "order는 null일 수 없다.");
    Objects.requireNonNull(options, "options는 null일 수 없다.");
    Objects.requireNonNull(answerIndex, "answerIndex는 null일 수 없다.");

    validateQuizOrderDuplicate(order);

    Quiz quiz = Quiz.create(question, order, options, answerIndex);
    quizzes.add(quiz);
    return quiz;
}

```

`Quiz` 자체도 내부에서 이런 검증을 한다:

```java
private Quiz(String question, QuestionOrder questionOrder, QuizOptions options, AnswerIndex answerIndex) {
    // null 체크들 ...

    int optionCount = options.getOptions().size();
    if (answerIndex.getValue() < 1 || answerIndex.getValue() > optionCount) {
        throw new IllegalArgumentException("answerIndex가 options의 범위를 벗어났습니다.");
    }
    // ...
}

```

즉:

- `QuizOptions`는 **값 객체**
    - 서비스 혹은 다른 도메인 코드에서 만들 수 있다.
    - “보기 텍스트 중복 방지, 개수 제한(OPTION_COUNT)”는 `QuizOptions` 내부 책임.
- `Quiz`는 **엔티티**
    - “정답 인덱스가 보기 개수 안에 들어가는지”는 `Quiz` 생성자 책임.
- `DailyContent`는 **애그리거트 루트**
    - “하루 안에서 퀴즈 순번이 중복되지 않는지”를 책임.

이렇게 역할을 나누면:

- 서비스는

  “이번 daySequence에 이런 퀴즈를 추가해”라고 명령만 내리고,

- 실제 **규칙/제약은 DailyContent + Quiz + QuizOptions** 세 곳에 숨어 있게 된다.

  (그리고 그게 DDD의 의도이기도 하고.)


---

## 4. 잘못된 설계 예: 서비스에서 엔티티를 직접 만드는 순간 깨지는 것들

이번에는 같은 도메인으로 일부러 **나쁜 예**를 만들어보자.

### 4.1 서비스가 NewsItem을 직접 new 하는 경우

```java
// 나쁜 예 – 서비스에서 NewsItem 직접 생성
@Transactional
public void addNewsBad(Long dailyContentId, AddNewsCommand cmd) {
    DailyContent dc = dailyContentRepository.findById(dailyContentId)
        .orElseThrow(...);

    NewsItem item = new NewsItem(
        cmd.title(),
        WebLink.of(cmd.url()),
        new NewsItemOrder(cmd.order()),
        ImageFile.of(cmd.imageUrl())
    );

    dc.getNewsItems().add(item); // 컬렉션 getter로 받은 리스트에 직접 add
}

```

이렇게 하면:

1. **순번 중복 검증이 건너뛴다.**
    - `validateNewsOrderDuplicate` 같은 로직이 전혀 호출되지 않는다.
    - “1번 뉴스가 여러 개” 허용 가능.
2. **orphanRemoval/cascade 의도와 어긋날 수 있다.**
    - 컬렉션을 그대로 노출하면,

      외부에서 `dc.getNewsItems().clear()` 같은 것도 할 수 있다.

3. 규칙이 바뀌었을 때(예: “뉴스는 최대 3개만 허용”)
    - `DailyContent.addNewsItem`에만 로직을 넣어도 되는 게 아니라
    - 이런 “우회로”를 전부 찾아서 막아야 한다.

그래서 oneco에서는

- `getNewsItems()`를 `List.copyOf(newsItems)`로 감싸서 반환하고,
- 엔티티 생성은 **무조건 `addNewsItem`을 통하도록** 강제했다.

---

## 5. 다른 oneco 도메인에도 적용해보기: Category / Mission / Onboarding

이 원칙은 DailyContent에만 적혀 있는 게 아니라,

oneco의 다른 도메인에도 그대로 가져갈 수 있다.

### 5.1 Category → DailyContent들 생성

예를 들어, “돈의 흐름” 카테고리(2주 과정)가 있다고 하자.

- Category 애그리거트(혹은 도메인 서비스)가
    - 총 일차 수(14일)를 알고 있고
    - 각 DaySequence에 어떤 키워드/설명을 배치할지 계획을 알고 있다.

이 때 구조를 이렇게 가져갈 수 있다:

- `DaySequence` / `CategoryId` / `Keyword` / `ContentDescription` / `ImageFile`

  → **값 객체** → 도메인 서비스에서 자유롭게 만들어도 됨.

- `DailyContent`

  → **애그리거트 루트** → `DailyContent.create(...)` 로만 생성.

- 도메인 서비스 예시 느낌:

```java
public DailyContent generateDailyContentFor(Category category, int dayValue) {
    DaySequence daySequence = new DaySequence(dayValue);
    Keyword keyword = Keyword.of(category.keywordFor(daySequence));
    ContentDescription desc = ContentDescription.of(...);
    ImageFile image = ImageFile.of(...);

    return DailyContent.create(category.getId(), daySequence, keyword, desc, image);
}

```

여기서도 마찬가지로

- 값 객체는 도메인 서비스에서 자유롭게 조립
- 루트 생성은 팩토리/정적 메서드로 한정

이라는 패턴을 유지한다.

---

## 6. 정리: oneco 기준 실전 가이드라인 4개

1. **값 객체(VO)는 DTO를 받는 쪽에서 자유롭게 만들어도 된다.**
    - `CategoryId`, `DaySequence`, `Keyword`, `ContentDescription`, `ImageFile`, `WebLink`,

      `NewsItemOrder`, `QuestionOrder`, `AnswerIndex`, `QuizOptions` …

    - 단, **유효성 검증은 VO 내부**에 넣는다.
2. **엔티티(Entity)는 애그리거트 루트 내부에서만 생성하게 한다.**
    - `NewsItem`, `Quiz`는 항상 `DailyContent.addNewsItem/addQuiz`로만 추가.
    - `Mission`도 도메인 팩토리/정적 메서드로만 생성.
3. **애그리거트 루트는 애그리거트 내의 규칙을 책임진다.**
    - 하루 안에서 뉴스/퀴즈 순번 중복 방지
    - DailyContent와 연관된 엔티티의 add/remove 시 일관성 유지
    - Mission의 상태 전이, 보상 중복 지급 방지 등
4. **서비스는 orchestration에만 집중한다.**
    - “어느 DailyContent에 어떤 뉴스/퀴즈를 추가할지”를 결정하는 역할
    - 실제 규칙/ 검증/ 일관성은 DailyContent, Mission 같은 도메인 객체들이 맡는다.
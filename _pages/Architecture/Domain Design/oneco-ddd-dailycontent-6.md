---
title: "[ONECO DDD 도메인 설계 시리즈 Part 6] 퀴즈 보기(QuizOption)는 왜 VO + JSON으로 설계했을까?"
date: 2025-12-17 16:32:00 +0900
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

# [ONCEO DDD 도메인 설계 시리즈 Part 6] 퀴즈 보기(QuizOption)는 왜 VO + JSON으로 설계했을까?

## 0. 들어가며 – “퀴즈 보기, 어디까지 쪼갤 건데?”

내 서비스의 하루 학습 경험은 이렇게 생겼다.

> “키워드 설명을 읽고, 관련 뉴스를 보고, 마지막에 퀴즈 1문제를 푼다.
>
>
> 그 퀴즈에는 **여러 개의 보기(option)** 가 달려 있다.”
>

여기서 자연스럽게 나오는 질문이 있다.

- “이 **보기(option)** 를 DB에서 **어디까지 테이블로 쪼갤까?**”

선택지는 크게 둘이었다.

1. `quiz_options` 라는 테이블을 만들고,

   `quiz_id` 기준으로 1:N 로우를 두는 방식

2. 보기 전체를 하나의 값 객체(`QuizOptions`)로 보고,

   **JSON 컬럼에 통째로 박아 넣는 방식**


나는 2번, 즉

- `QuizOptions` 값 객체
- 내부에 `List<QuizOption>`
- JPA에서는 `AttributeConverter + JSON TEXT 컬럼`

이 조합을 선택했다.

이 글에서는

- 왜 별도 테이블 대신 **VO + JSON** 을 골랐는지,
- 이 구조가 실제 코드에서 어떻게 동작하는지,
- 장점/단점, 그리고 나중에 조회 요구가 커졌을 때 어떻게 확장할 수 있는지

까지 정리해보려고 한다.

---

## 1. 문제 상황 – “퀴즈 보기를 어디까지 정규화할까?”

처음에 스키마를 그릴 때, 머릿속에 떠오른 후보는 세 가지였다.

1. 퀴즈 + 보기 테이블 완전 정규화
- `quizzes`
- `quiz_options`
- 구조 예시
    - `quizzes(id, question, answer_index, …)`
    - `quiz_options(id, quiz_id, option_order, text)`

장점

- 완전 RDB스러운 모델이다.
- 보기 하나하나를 대상으로
    - 검색
    - 통계
    - 인덱스

      를 하고 싶을 때 깔끔하다.


단점

- 우리 서비스의 **도메인에서 “퀴즈 보기”는 어느정도 중요한가?**
    - 사용자가 “보기만 따로 관리”하는 유즈케이스는 없다.
    - 항상 “퀴즈 한 문제” 단위로 함께 움직인다.
- 코드에서 `Quiz`와 `QuizOption` 사이를 계속 조합해야 한다.
    - 도메인 관점에서 “한 문제 + 그에 딸린 보기들”이라는 응집을 깨는 느낌이 강했다.
1. 퀴즈 테이블에 컬럼으로 펼치기
- `quizzes`
- 컬럼 예시
    - `option1_text`
    - `option2_text`
    - `option3_text`
    - `option4_text`
    - …

장점

- 쿼리가 단순하다.

  `select question, option1_text, option2_text … from quizzes`


단점

- 정책이 바뀔 때마다 스키마가 깨진다.
    - 지금은 2지선다인데, 나중에 “4지선다로 늘리자”가 나오면?
    - 또 나중에 “보기는 2~5개까지 유동적이게 하자”가 나오면?
- “도메인 정책의 변화”가 “DDL 변경”까지 끌고 가버린다.

3.. 퀴즈 한 문제 + 보기 리스트를 하나로 보고 JSON에 담기

- `quizzes(options_json TEXT)`
- 도메인에서는 `QuizOptions` 값 객체로 캡슐화
- DB에는 `["보기1","보기2"]` 같은 JSON 배열로 저장

장점/단점은 뒤에서 자세히 다루고,

일단 **내가 실제로 선택한 건 3번**이었다.

---

## 2. 현재 구조 – QuizOptions 값 객체 + QuizOption 리스트

도메인 구조는 이렇게 생겼다.

### 2.1 QuizOption – “보기 하나”를 표현하는 VO

```java
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
@EqualsAndHashCode
public class QuizOption {

    // DB에는 QuizOptions의 JSON으로 함께 저장된다.
    private String text;

    private QuizOption(String text) {
        if (text == null || text.isBlank()) {
            throw new IllegalArgumentException("QuizOption의 text는 비어 있을 수 없습니다.");
        }
        this.text = text.trim();
    }

    public static QuizOption of(String text) {
        return new QuizOption(text);
    }
}

```

의도

- “보기 하나”를 단순 `String`으로 쓰지 않고 **타입으로 구분**하고 싶었다.
- 생성 시점에
    - null / 공백 문자열 방지
    - 트림 처리

      를 값 객체 내부에서 처리한다.


### 2.2 QuizOptions – 보기 리스트를 감싸는 VO

```java
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
@EqualsAndHashCode
public class QuizOptions {

    // 현재는 2지선다 정책
    public static final int OPTION_COUNT = 2;

    private List<QuizOption> options;

    private QuizOptions(List<QuizOption> options) {
        if (options == null || options.isEmpty()) {
            throw new IllegalArgumentException("QuizOptions는 비어 있을 수 없습니다.");
        }

        if (options.stream().anyMatch(Objects::isNull)) {
            throw new IllegalArgumentException("QuizOptions에 null 보기는 포함될 수 없습니다.");
        }

        if (options.size() != OPTION_COUNT) {
            throw new IllegalArgumentException("QuizOptions는 정확히 " + OPTION_COUNT + "개여야 합니다.");
        }

        long distinctCount = options.stream()
            .map(QuizOption::getText)
            .distinct()
            .count();

        if (distinctCount != options.size()) {
            throw new IllegalArgumentException("퀴즈 보기 텍스트는 중복될 수 없습니다.");
        }

        // 불변 리스트로 방어적 복사
        this.options = List.copyOf(options);
    }

    public static QuizOptions of(List<QuizOption> options){
        return new QuizOptions(options);
    }

    public static QuizOptions ofTexts(List<String> texts) {
        if (texts == null) {
            throw new IllegalArgumentException("texts는 null일 수 없습니다.");
        }

        List<QuizOption> list = texts.stream()
            .map(QuizOption::of)
            .toList();

        return new QuizOptions(list);
    }
}

```

여기서 중요한 포인트:

1. 옵션 개수 정책을 VO 안에 숨겼다.
    - 지금은 `OPTION_COUNT = 2`로 2지선다.
    - 나중에 정책이 바뀌면
        - `OPTION_COUNT`를 바꾸거나
        - 범위 조건 (`2 <= size <= 4`)로 바꾸는 식으로 확장할 여지가 있다.
    - “보기 개수”라는 도메인 규칙이 컨트롤러/서비스가 아니라 **값 객체 내부**에 있다.
2. 중복 텍스트를 허용하지 않는다.
    - `["예", "예"]` 같은 보기 리스트는 도메인에서 막는다.
3. 리스트를 **불변 리스트**로 만든다.
    - `List.copyOf(options)`를 써서 내부에 복사본을 만들고,
    - 그 복사본을 수정 불가능 리스트로 만들어준다.
    - 그래서 호출자가 `quizOptions.getOptions().add(...)` 같은 시도를 해도

      `UnsupportedOperationException`으로 막힌다.


이 구조 때문에 “보기 리스트”와 관련된 비즈니스 규칙은 모두 `QuizOptions` 안에 모인다.

서비스 레이어/엔티티는 “검증된 값 객체”만 받아서 쓰면 된다.

---

## 3. JPA 레이어 – AttributeConverter + JSON TEXT 컬럼

이제 이 VO를 DB에 어떻게 저장할지 보자.

### 3.1 Quiz 엔티티 쪽 매핑

```java
@Entity
@Table(name = "quizzes",
    uniqueConstraints = {
        @UniqueConstraint(
            name = "uk_daily_question_order",
            columnNames = {"daily_content_id", "question_order"}
        )
    })
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Quiz {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "question", nullable = false, length = 500)
    private String question;

    @Convert(converter = QuestionOrderConverter.class)
    @Column(name = "question_order", nullable = false)
    private QuestionOrder questionOrder;

    @Embedded
    private AnswerIndex answerIndex;

    @Convert(converter = QuizOptionsConverter.class)
    @Column(name = "options_json", nullable = false, columnDefinition = "TEXT")
    private QuizOptions options;

    ...
}

```

DB 입장에서는:

- `options_json` TEXT 컬럼 하나만 있으면 된다.
- 그 안에는 `["보기1","보기2"]` 같은 JSON 문자열이 들어간다.

### 3.2 QuizOptionsConverter – JSON ↔ VO 변환 책임

```java
@Converter(autoApply = true)
public class QuizOptionsConverter implements AttributeConverter<QuizOptions, String> {

    private static final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public String convertToDatabaseColumn(QuizOptions attribute) {
        if (attribute == null) {
            throw new IllegalArgumentException("QuizOptions가 null일 수 없습니다.");
        }

        try {
            List<String> texts = attribute.getOptions().stream()
                .map(QuizOption::getText)
                .toList();

            // List<String> -> '["보기1","보기2"]'
            return objectMapper.writeValueAsString(texts);

        } catch (Exception e) {
            throw new IllegalStateException("QuizOptions를 JSON으로 변환하는 데 실패했습니다.", e);
        }
    }

    @Override
    public QuizOptions convertToEntityAttribute(String dbData) {
        if (dbData == null || dbData.isBlank()) {
            throw new IllegalArgumentException("DB 데이터가 null이거나 비어있습니다.");
        }

        try {
            List<String> texts = objectMapper.readValue(
                dbData,
                new TypeReference<List<String>>() {}
            );

            return QuizOptions.ofTexts(texts);

        } catch (Exception e) {
            throw new IllegalStateException("JSON을 QuizOptions로 변환하는 데 실패했습니다.", e);
        }
    }
}

```

여기서도 의도가 분명하다.

- Quiz 엔티티는 오직 `QuizOptions`라는 도메인 타입만 본다.
- JSON 직렬화/역직렬화 책임은 **Converter 한 군데로 모았다.**
- DB에 어떤 포맷으로 저장되는지(배열, 객체, 버전 필드 등)는

  나중에 이 Converter를 바꾸면 된다.


---

## 4. 장점 – 도메인 응집도를 중심에 두기

### 4.1 도메인 코드에서 옵션 리스트를 불변 리스트로 관리

`QuizOptions`는 `List.copyOf(...)`로 방어적 복사를 해서 “사실상 불변”으로 만든다.

- 외부에서 `getOptions()`로 가져간 리스트는 `add/remove`가 안 된다.
- “보기의 개수/내용을 변경”하는 건 항상 **새로운 QuizOptions를 만들어서 교체**하는 식이 된다.
    - 불변성에 가까운 사용 패턴이다.

이 덕분에 “보기 개수”나 “중복 방지” 같은 규칙이 무너지기 어렵다.

### 4.2 보기 정책을 VO 내부로 캡슐화

지금은 2지선다라서 `OPTION_COUNT = 2`로 막고 있지만,

나중에 이렇게 바꾸고 싶어질 수 있다.

- “보기는 최소 2개, 최대 4개까지 허용”
- “보기 개수는 카테고리마다 다르게 가져가자”

그때 서비스/컨트롤러 단계에 흩어져 있는 if문을 고치는 게 아니라,

- `QuizOptions` 내부의 검증 로직을 수정하거나,
- 정책 객체를 주입받도록 바꾸는 식으로 확장할 수 있다.

“보기 리스트”라는 도메인 규칙의 집합이

**한 클래스(QuizOptions)에 캡슐화**되어 있다는 게 포인트다.

### 4.3 엔티티는 검증된 값 객체만 받는다

서비스 레이어에서는 보통 이렇게 쓴다.

```java
List<String> texts = List.of("돈의 흐름이 좋아진다", "돈의 흐름이 나빠진다");
QuizOptions options = QuizOptions.ofTexts(texts);
AnswerIndex answerIndex = new AnswerIndex(1); // 1번 보기 정답

dailyContent.addQuiz(
    question,
    new QuestionOrder(1),
    options,
    answerIndex
);

```

- 값 객체는 서비스에서 만들어도 된다. (검증 책임은 VO 안에 있기 때문)
- 하지만 엔티티(`Quiz`)는 서비스에서 `new` 하지 않고,
    - 항상 애그리거트 루트(`DailyContent`)의 도메인 메서드(`addQuiz`)를 통해서만 생성한다.

이렇게 하면

- “퀴즈 생성 시 반드시 order 중복, answerIndex 범위 체크 등을 하고 싶다”

  → 그 로직은 루트 애그리거트(`DailyContent.addQuiz`)에 모이면 된다.

- 서비스는 “유효한 값 객체를 만들어서 루트에게 전달”하는 역할에 집중한다.

### 4.4 DB 스키마가 단순해진다

- `quizzes` 테이블 안에 `options_json TEXT` 컬럼 하나만 추가하면 된다.
- 별도 `quiz_options` 테이블을 만들 필요가 없다.
- 운영/초기 마이그레이션/쿼리 작성이 상대적으로 단순하다.

---

## 5. 단점 – 조회/통계/검색 입장에서의 손해

물론 장점만 있는 건 아니다.

### 5.1 SQL 수준에서 “보기 텍스트”로 검색하기 어렵다

예를 들어 이런 요구가 생겼다고 하자.

- “보기 중에 ‘인플레이션’이라는 단어가 들어간 퀴즈를 모두 찾아줘”

지금 구조에서는

- `options_json`이 TEXT + JSON이라,
- RDB 표준 SQL만으로는 깔끔하게 질의하기 어렵다.
    - 결국 `like '%인플레이션%'` 같은 문자열 검색에 가까워진다.
- MySQL JSON 함수나 외부 검색엔진(ElasticSearch 등)을 붙이지 않는 이상,
    - 인덱스/쿼리 최적화에 한계가 있다.

### 5.2 통계/리포트 요구가 커지면 모델을 바꾸고 싶어질 수 있음

나중에 이런 기능들이 들어올 수 있다.

- “가장 많이 선택된 오답 보기 TOP 10 보여줘”
- “보기로 ‘상승’, ‘하락’을 쓰는 문제의 정답률을 비교해줘”

이때는

- 보기 단위로 집계해야 한다.
- 지금처럼 옵션을 JSON으로 뭉쳐놓으면

  **분석/집계 파이프라인이 조금 더 복잡해진다.**


“서비스 초기에 **도메인 응집도**를 우선하고,

나중에 조회/통계가 중요해지면 읽기 모델을 따로 뺀다”는 구도가 필요하다.

---

## 6. 정리

이 프로젝트에서 퀴즈 보기(QuizOption)는 이렇게 설계했다.

- 도메인에서는
    - `QuizOption` / `QuizOptions` 값 객체로 의미를 부여하고,
    - 개수, 중복, null, 불변성 등 규칙을 VO 내부에 캡슐화했다.
- JPA/DB에서는
    - `QuizOptionsConverter`를 통해 JSON TEXT 하나로 압축해서 저장했다.
- 그 대가로
    - SQL 레벨에서 보기 텍스트를 기준으로 검색/통계를 하기 어렵다는 단점이 있다.
    - 대신 나중에 Projection/조회 전용 모델을 도입해 보완하는 전략을 가져간다.

요약하면, 초반에는

> “퀴즈 한 문제 + 보기 리스트”라는 도메인 응집도를 지키는 쪽
>

을 택했고,

조회/통계가 중요해졌을 때는

> 읽기 모델/Projection을 외부에 덧붙이는 방식
>

으로 확장하는 그림을 생각중이다.